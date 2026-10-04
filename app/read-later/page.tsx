import { Suspense } from 'react'
import BookmarkBrowser from '@/components/bookmark-browser'

export default function ReadLaterPage() {
  return (
    <Suspense>
      <BookmarkBrowser readLater />
    </Suspense>
  )
}
