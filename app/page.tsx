import { redirect } from 'next/navigation';
import { newProjectId } from '@/store/projects';

export const dynamic = 'force-dynamic';

/** M0 is a single page: every visit to / starts a fresh project. */
export default function Index() {
  redirect(`/${newProjectId()}`);
}
