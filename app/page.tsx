import { modelName, resolveProviderName } from '@/agent/providers';
import { listProjects } from '@/store/projects';
import { Landing } from '@/ui/Landing';

export const dynamic = 'force-dynamic';

/** Home: start a project from a sentence, or reopen a recent one. */
export default function Index() {
  let provider = 'misconfigured';
  let model = '';
  try {
    const name = resolveProviderName();
    provider = name;
    model = modelName(name, 'code');
  } catch (err) {
    model = (err as Error).message;
  }
  const projects = listProjects(9).map(({ id, name, updatedAt }) => ({ id, name, updatedAt }));
  return <Landing projects={projects} provider={provider} model={model} />;
}
