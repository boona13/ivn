import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IVN_KNOWLEDGE_SPEC_VERSION = '1.0.0';

const SPEC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
const EXPORT_SCHEMA_FILE = 'ivn-export.schema.json';
const PACK_MANIFEST_SCHEMA_FILE = 'ivn-pack-manifest.schema.json';
const SERVICE_OPENAPI_FILE = 'ivn-service.openapi.json';
const SPEC_DOC_FILE = 'SPEC.md';

export interface SpecInfo {
  version: string;
  directory: string;
  export_schema_path: string;
  pack_manifest_schema_path: string;
  service_openapi_path: string;
  spec_doc_path: string;
}

export function getSpecInfo(): SpecInfo {
  return {
    version: IVN_KNOWLEDGE_SPEC_VERSION,
    directory: SPEC_DIR,
    export_schema_path: join(SPEC_DIR, EXPORT_SCHEMA_FILE),
    pack_manifest_schema_path: join(SPEC_DIR, PACK_MANIFEST_SCHEMA_FILE),
    service_openapi_path: join(SPEC_DIR, SERVICE_OPENAPI_FILE),
    spec_doc_path: join(SPEC_DIR, SPEC_DOC_FILE),
  };
}

export function ensureSpecFilesAvailable(): void {
  const info = getSpecInfo();
  for (const path of [
    info.export_schema_path,
    info.pack_manifest_schema_path,
    info.service_openapi_path,
    info.spec_doc_path,
  ]) {
    if (!existsSync(path)) {
      throw new Error(`IVN spec file is missing: ${path}`);
    }
  }
}

export function exportSpecFiles(outDir: string): SpecInfo {
  const info = getSpecInfo();
  ensureSpecFilesAvailable();
  mkdirSync(outDir, { recursive: true });

  copyFileSync(info.export_schema_path, join(outDir, EXPORT_SCHEMA_FILE));
  copyFileSync(info.pack_manifest_schema_path, join(outDir, PACK_MANIFEST_SCHEMA_FILE));
  copyFileSync(info.service_openapi_path, join(outDir, SERVICE_OPENAPI_FILE));
  copyFileSync(info.spec_doc_path, join(outDir, SPEC_DOC_FILE));

  return {
    ...info,
    directory: outDir,
    export_schema_path: join(outDir, EXPORT_SCHEMA_FILE),
    pack_manifest_schema_path: join(outDir, PACK_MANIFEST_SCHEMA_FILE),
    service_openapi_path: join(outDir, SERVICE_OPENAPI_FILE),
    spec_doc_path: join(outDir, SPEC_DOC_FILE),
  };
}

export function getServiceOpenApiDocument(): unknown {
  const info = getSpecInfo();
  ensureSpecFilesAvailable();
  return JSON.parse(readFileSync(info.service_openapi_path, 'utf8'));
}

export function assertSupportedSpecVersion(specVersion?: string | null): string {
  if (!specVersion) return 'legacy';

  const supportedMajor = IVN_KNOWLEDGE_SPEC_VERSION.split('.')[0];
  const incomingMajor = specVersion.split('.')[0];
  if (incomingMajor !== supportedMajor) {
    throw new Error(
      `Unsupported IVN knowledge spec version ${specVersion}. ` +
      `This build supports ${IVN_KNOWLEDGE_SPEC_VERSION}.`,
    );
  }

  return specVersion;
}
