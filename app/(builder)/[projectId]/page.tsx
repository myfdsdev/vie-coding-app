import { notFound } from 'next/navigation';
import { modelName, resolveProviderName } from '@/agent/providers';
import { previewHost, publicPort } from '@/sandbox/docker';
import { isProjectId } from '@/store/projects';
import { Builder } from '@/ui/Builder';

export const dynamic = 'force-dynamic';

export default function BuilderPage({ params }: { params: { projectId: string } }) {
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

  return (
    <Builder
      projectId={projectId}
      provider={provider}
      model={model}
      previewUrl={`http://${previewHost(projectId)}:${publicPort()}`}
    />
  );
}
