import { listProjectFiles, readProjectFile } from '../store/projects';
import { entityPath, parseEntity, type Entity } from './entities';
import { ApiError } from './store';

/**
 * Loading the data model from a project's entities/ folder. The files are
 * ordinary project files: the model writes them, the user sees them in the
 * file tree, and version history covers them like any other code.
 */

export const ENTITY_DIR = 'entities/';
const ENTITY_FILE = /^entities\/([A-Z][A-Za-z0-9]{0,30})\.json$/;

/** Entity file paths in a project, sorted so everything downstream is stable. */
export async function entityFiles(projectId: string): Promise<string[]> {
  const files = await listProjectFiles(projectId);
  return files.filter((f) => ENTITY_FILE.test(f)).sort();
}

/** Every entity the app declares. Invalid files are skipped here; the gate reports them. */
export async function loadEntities(projectId: string): Promise<Entity[]> {
  const entities: Entity[] = [];
  for (const file of await entityFiles(projectId)) {
    const source = await readProjectFile(projectId, file);
    if (source === null) continue;
    try {
      entities.push(parseEntity(source, file).entity);
    } catch {
      // A broken entity file cannot serve requests; VALIDATE surfaces it to the model.
    }
  }
  return entities;
}

/** One entity by name, for an API request. */
export async function loadEntity(projectId: string, name: string): Promise<Entity> {
  if (!/^[A-Za-z0-9]{1,31}$/.test(name)) throw new ApiError(404, 'That data type does not exist in this app.');
  const source = await readProjectFile(projectId, entityPath(name));
  if (source === null) throw new ApiError(404, `This app has no "${name}" data.`);
  try {
    return parseEntity(source, entityPath(name)).entity;
  } catch (err) {
    throw new ApiError(500, `The "${name}" data model is not valid: ${(err as Error).message}`);
  }
}
