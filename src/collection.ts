import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";

// --- Types ---

export interface CollectionMeta {
  dbPath: string;
  sourcePath: string;
  createdAt: string;
}

export interface CollectionRegistry {
  [name: string]: CollectionMeta;
}

// --- Paths ---

function getQscHome(): string {
  return resolve(homedir(), ".qsc");
}

function getRegistryPath(): string {
  return join(getQscHome(), "collections.json");
}

function getCollectionsDir(): string {
  return join(getQscHome(), "collections");
}

// --- Registry I/O ---

function readRegistry(): CollectionRegistry {
  const registryPath = getRegistryPath();
  if (!existsSync(registryPath)) {
    return {};
  }
  const raw = readFileSync(registryPath, "utf-8");
  return JSON.parse(raw) as CollectionRegistry;
}

function writeRegistry(registry: CollectionRegistry): void {
  const registryPath = getRegistryPath();
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

// --- Public API ---

export function ensureQscHome(): void {
  const home = getQscHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }
  const collectionsDir = getCollectionsDir();
  if (!existsSync(collectionsDir)) {
    mkdirSync(collectionsDir, { recursive: true });
  }
}

export function getCollectionDbPath(name: string): string {
  return join(getCollectionsDir(), `${name}.sqlite`);
}

export function listCollections(): CollectionRegistry {
  return readRegistry();
}

export function getCollection(name: string): CollectionMeta | undefined {
  const registry = readRegistry();
  return registry[name];
}

export function registerCollection(
  name: string,
  sourcePath: string,
  dbPath?: string,
): CollectionMeta {
  ensureQscHome();

  const finalDbPath = dbPath ?? getCollectionDbPath(name);
  const meta: CollectionMeta = {
    dbPath: finalDbPath,
    sourcePath: resolve(sourcePath),
    createdAt: new Date().toISOString(),
  };

  const registry = readRegistry();
  registry[name] = meta;
  writeRegistry(registry);

  return meta;
}

export function removeCollection(name: string): boolean {
  const registry = readRegistry();
  if (!registry[name]) return false;
  delete registry[name];
  writeRegistry(registry);
  return true;
}

export function resolveCollectionDb(name: string): string {
  const meta = getCollection(name);
  if (!meta) {
    throw new Error(
      `Collection '${name}' not found. Run 'qsc init ${name} <path>' first.`,
    );
  }
  return meta.dbPath;
}

export function resolveCollectionSourcePath(name: string): string {
  const meta = getCollection(name);
  if (!meta) {
    throw new Error(
      `Collection '${name}' not found. Run 'qsc init ${name} <path>' first.`,
    );
  }
  return meta.sourcePath;
}

export function copyCollection(
  sourceName: string,
  destName: string,
  newSourcePath: string,
): CollectionMeta {
  const sourceMeta = getCollection(sourceName);
  if (!sourceMeta) {
    throw new Error(`Source collection '${sourceName}' not found.`);
  }
  if (!existsSync(sourceMeta.dbPath)) {
    throw new Error(`Source database not found: ${sourceMeta.dbPath}`);
  }

  ensureQscHome();

  const destDbPath = getCollectionDbPath(destName);
  copyFileSync(sourceMeta.dbPath, destDbPath);

  return registerCollection(destName, newSourcePath, destDbPath);
}

export function importCollection(
  name: string,
  sqlitePath: string,
  sourcePath: string,
): CollectionMeta {
  const absSource = resolve(sqlitePath);
  if (!existsSync(absSource)) {
    throw new Error(`SQLite file not found: ${absSource}`);
  }

  ensureQscHome();

  const destDbPath = getCollectionDbPath(name);
  copyFileSync(absSource, destDbPath);

  return registerCollection(name, sourcePath, destDbPath);
}

export function exportCollection(name: string, outputPath: string): void {
  const meta = getCollection(name);
  if (!meta) {
    throw new Error(`Collection '${name}' not found.`);
  }
  if (!existsSync(meta.dbPath)) {
    throw new Error(`Database not found: ${meta.dbPath}`);
  }

  const absOutput = resolve(outputPath);
  const outDir = dirname(absOutput);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  copyFileSync(meta.dbPath, absOutput);
}
