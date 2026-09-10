import { notFound } from 'next/navigation';
import { modelName, resolveProviderName } from '@/agent/providers';
import { previewHost, publicPort } from '@/sandbox/docker';
import { listMessages } from '@/store/chats';
import { ensureProject, isProjectId, listProjectFiles, projectExists } from '@/store/projects';
import { Builder } from '@/ui/Builder';

export const dynamic = 'force-dynamic';

export default async function BuilderPage({ params }: { params: { projectId: string } }) {
  const { projectId } = params;
  if (!isProjectId(projectId)) notFound();

  let provider: string;
  let model: string;
  try {
    const name = resolveProviderName();
    provider = name;
    model = modelName(name, 'code');
  } catch (err) {
    provider = 'misconfigured';
    model = (err as Error).message;
  }

  // Projects opened by URL (or from before M1) get their record on first visit.
  const project = ensureProject(projectId);
  const files = (await projectExists(projectId)) ? await listProjectFiles(projectId) : [];

  return (
    <Builder
      project={{ id: project.id, name: project.name }}
      provider={provider}
      model={model}
      previewUrl={`http://${previewHost(projectId)}:${publicPort()}`}
      initialMessages={listMessages(projectId)}
      initialFiles={files}
    />
  );
}
