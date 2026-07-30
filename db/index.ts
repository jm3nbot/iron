import type { WorkspaceRepository } from "./types";

let repositoryPromise: Promise<WorkspaceRepository | null> | null = null;

export function getWorkspaceRepository() {
  if (!repositoryPromise) {
    repositoryPromise = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (connectionString) {
        const { getPostgresRepository } = await import("./postgres");
        const repository = getPostgresRepository(connectionString);
        await repository.ensure();
        return repository;
      }

      if (process.env.VERCEL || process.env.NITRO_PRESET === "vercel") {
        return null;
      }

      const { getD1Repository } = await import("./d1");
      const repository = getD1Repository();
      await repository.ensure();
      return repository;
    })();
  }
  return repositoryPromise;
}

export type {
  DatabaseChanges,
  DatabaseItem,
  WorkspaceRepository,
} from "./types";
