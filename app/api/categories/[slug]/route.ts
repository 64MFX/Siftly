import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { parseLinkCard } from '@/lib/link-card'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

function parseIntParam(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed
}

interface RouteContext {
  params: Promise<{ slug: string }>
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { slug } = await context.params
  const { searchParams } = new URL(request.url)

  const page = parseIntParam(searchParams.get('page'), DEFAULT_PAGE)
  const limit = Math.min(parseIntParam(searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT)
  const skip = (page - 1) * limit

  try {
    const category = await prisma.category.findUnique({
      where: { slug },
    })

    if (!category) {
      return NextResponse.json({ error: `Category not found: ${slug}` }, { status: 404 })
    }

    const [bookmarks, total] = await Promise.all([
      prisma.bookmark.findMany({
        where: {
          categories: {
            some: { category: { slug } },
          },
        },
        skip,
        take: limit,
        orderBy: { importedAt: 'desc' },
        include: {
          mediaItems: true,
          categories: {
            include: {
              category: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  color: true,
                },
              },
            },
          },
        },
      }),
      prisma.bookmark.count({
        where: {
          categories: {
            some: { category: { slug } },
          },
        },
      }),
    ])

    const formatted = bookmarks.map((bookmark) => ({
      id: bookmark.id,
      tweetId: bookmark.tweetId,
      text: bookmark.text,
      authorHandle: bookmark.authorHandle,
      authorName: bookmark.authorName,
      tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
      importedAt: bookmark.importedAt.toISOString(),
      archivedAt: bookmark.archivedAt?.toISOString() ?? null,
      archiveStatus: bookmark.archiveStatus,
      linkCard: parseLinkCard(bookmark.linkCard),
      readLaterAt: bookmark.readLaterAt?.toISOString() ?? null,
      mediaItems: bookmark.mediaItems.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        thumbnailUrl: m.thumbnailUrl,
        localPath: m.localPath,
        localThumbnailPath: m.localThumbnailPath,
      })),
      categories: bookmark.categories.map((bc) => ({
        id: bc.category.id,
        name: bc.category.name,
        slug: bc.category.slug,
        color: bc.category.color,
        confidence: bc.confidence,
      })),
    }))

    return NextResponse.json({
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        color: category.color,
        description: category.description,
        isAiGenerated: category.isAiGenerated,
        createdAt: category.createdAt.toISOString(),
      },
      bookmarks: formatted,
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error(`Category [${slug}] fetch error:`, err)
    return NextResponse.json(
      { error: `Failed to fetch category: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

const MAX_NAME_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 1000

/**
 * Edit a category's name, description and/or color. The slug stays the same so
 * links, filters and existing AI assignments keep working after a rename.
 */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { slug } = await context.params

  let body: { name?: unknown; description?: unknown; color?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const data: { name?: string; description?: string | null; color?: string } = {}

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return NextResponse.json({ error: 'Category name cannot be empty' }, { status: 400 })
    }
    const name = body.name.trim()
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `Category name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 })
    }
    data.name = name
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return NextResponse.json({ error: 'Description must be a string or null' }, { status: 400 })
    }
    const description = body.description?.trim() ?? ''
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        { error: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` },
        { status: 400 }
      )
    }
    data.description = description || null
  }

  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(body.color)) {
      return NextResponse.json({ error: 'Color must be a hex value like #6366f1' }, { status: 400 })
    }
    data.color = body.color
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'Nothing to update: send name, description or color' }, { status: 400 })
  }

  try {
    const category = await prisma.category.findUnique({ where: { slug }, select: { id: true } })
    if (!category) {
      return NextResponse.json({ error: `Category not found: ${slug}` }, { status: 404 })
    }

    if (data.name !== undefined) {
      const clash = await prisma.category.findFirst({
        where: { name: data.name, NOT: { id: category.id } },
        select: { id: true },
      })
      if (clash) {
        return NextResponse.json({ error: 'Another category already has that name' }, { status: 409 })
      }
    }

    const updated = await prisma.category.update({
      where: { slug },
      data: { ...data, userEdited: true },
      include: { _count: { select: { bookmarks: true } } },
    })

    return NextResponse.json({
      category: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        color: updated.color,
        description: updated.description,
        isAiGenerated: updated.isAiGenerated,
        createdAt: updated.createdAt.toISOString(),
        bookmarkCount: updated._count.bookmarks,
      },
    })
  } catch (err) {
    console.error(`Category [${slug}] update error:`, err)
    return NextResponse.json(
      { error: `Failed to update category: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { slug } = await context.params

  try {
    const category = await prisma.category.findUnique({
      where: { slug },
      select: { id: true, name: true },
    })

    if (!category) {
      return NextResponse.json({ error: `Category not found: ${slug}` }, { status: 404 })
    }

    // Delete the category (BookmarkCategory records cascade via schema)
    await prisma.category.delete({
      where: { slug },
    })

    return NextResponse.json({
      deleted: true,
      slug,
      name: category.name,
    })
  } catch (err) {
    console.error(`Category [${slug}] delete error:`, err)
    return NextResponse.json(
      { error: `Failed to delete category: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
