// Reads META-INF/package.xml of a TWX: the app's identity, its toolkit
// dependencies and the declared object list. Verified on BAW 8.6.6 exports.

import { attr, child, children, parseXml } from './xml';

export interface TwxProject {
  id?: string;
  name?: string;
  shortName?: string;
  isToolkit: boolean;
}

export interface TwxDependency {
  /** dependency@id without "2069.": the prefix of "<prefix>/12.…" references. */
  prefix?: string;
  projectId?: string;
  name?: string;
  shortName?: string;
  snapshotId?: string;
  snapshotName?: string;
  isSystem: boolean;
}

export interface DeclaredObject {
  id: string;
  name?: string;
  type?: string;
  versionId?: string;
}

export interface TwxPackageInfo {
  project: TwxProject;
  branch?: string;
  snapshot?: string;
  snapshotId?: string;
  /** buildVersion, e.g. "8.6.6". */
  buildVersion?: string;
  /** fixPack, e.g. "23020". */
  fixPack?: string;
  buildDescription?: string;
  dependencies: TwxDependency[];
  /** Objects declared in package.xml, by id, in document order. */
  objects: Map<string, DeclaredObject>;
}

export const DEPENDENCY_ID_PREFIX = '2069.';

/** Parses package.xml. Throws on XML that is not well formed. */
export function readPackageXml(xml: string): TwxPackageInfo {
  const root = parseXml(xml);
  const target = child(root, 'target');
  const project = child(target, 'project');
  const branch = child(target, 'branch');
  const snapshot = child(target, 'snapshot');

  const dependencies: TwxDependency[] = children(child(root, 'dependencies'), 'dependency').map((d) => {
    const p = child(d, 'project');
    const s = child(d, 'snapshot');
    const id = attr(d, 'id');
    return {
      prefix: id?.startsWith(DEPENDENCY_ID_PREFIX) ? id.slice(DEPENDENCY_ID_PREFIX.length) : id,
      projectId: attr(p, 'id'),
      name: attr(p, 'name'),
      shortName: attr(p, 'shortName'),
      snapshotId: attr(s, 'id'),
      snapshotName: attr(s, 'name'),
      isSystem: attr(p, 'isSystem')?.toLowerCase() === 'true',
    };
  });

  const objects = new Map<string, DeclaredObject>();
  for (const o of children(child(root, 'objects'), 'object')) {
    const id = attr(o, 'id');
    if (id) objects.set(id, { id, name: attr(o, 'name'), type: attr(o, 'type'), versionId: attr(o, 'versionId') });
  }

  return {
    project: {
      id: attr(project, 'id'),
      name: attr(project, 'name'),
      shortName: attr(project, 'shortName'),
      isToolkit: (attr(project, 'isToolkit') ?? attr(project, 'toolkit'))?.toLowerCase() === 'true',
    },
    branch: attr(branch, 'name'),
    snapshot: attr(snapshot, 'name'),
    snapshotId: attr(snapshot, 'id'),
    buildVersion: attr(root, 'buildVersion') ?? attr(root, 'productVersion') ?? attr(root, 'version'),
    fixPack: attr(root, 'fixPack'),
    buildDescription: attr(root, 'buildDescription'),
    dependencies,
    objects,
  };
}

/** "System Data 8.6.0.0" */
export function dependencyLabel(d: TwxDependency): string {
  const name = d.name ?? d.shortName ?? d.projectId ?? d.prefix ?? 'Unknown toolkit';
  return d.snapshotName ? `${name} ${d.snapshotName}` : name;
}
