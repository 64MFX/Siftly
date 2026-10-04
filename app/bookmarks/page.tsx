import { Suspense } from 'react'
import BookmarkBrowser from '@/components/bookmark-browser'

export default function BookmarksPage() {
  return (
    <Suspense>
      <BookmarkBrowser />
    </Suspense>
  )
}
