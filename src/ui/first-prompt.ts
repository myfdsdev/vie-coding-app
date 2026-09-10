/** The home page leaves the first request here (sessionStorage) for the builder to send once it opens. */
export const firstPromptKey = (projectId: string) => `forge:first-prompt:${projectId}`;
