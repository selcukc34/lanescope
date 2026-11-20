// Reads a whole .twx export into the shared model: every BPD with a diagram
// becomes a Process, the app's business objects become data types. A service
// a BPD calls is read one level deep (./serviceReader); its diagram, and the
// diagrams of the services it calls, are read when the viewer opens them
// (./calleeDiagrams). Of the packed toolkits only package.xml is read, and
// only to name the coach views that controls use.

import { DoctypeError, doctypeOpenErrorMessage, doctypeSkippedWarning, hasDoctype } from '../input/xmlGuard';
import type { ProcessPackage, Process } from '../model/model';
import { readBpd } from './bpdReader';
import { TwxCalleeDiagrams } from './calleeDiagrams';
import { dependencyLabel, readPackageXml, type TwxPackageInfo } from './packageXml';
import { TwxResolver } from './resolver';
import { readTwxFile, TwxReadError, type TwxArchive, type TwxLimits } from './twxReader';

/** Reads a .twx file from disk into the shared model. */
export async function readTwxPackage(filePath: string, limits: Partial<TwxLimits> = {}): Promise<ProcessPackage> {
  return twxToProcessPackage(await readTwxFile(filePath, limits));
}

/** Maps an archive read by readTwxArchive/readTwxFile onto the shared model. */
export async function twxToProcessPackage(archive: TwxArchive): Promise<ProcessPackage> {
  const warnings = [...archive.warnings];
  let info: TwxPackageInfo | undefined;
  if (archive.packageXml !== undefined) {
    try {
      info = readPackageXml(archive.packageXml);
    } catch (err) {
      throw new TwxReadError(`META-INF/package.xml could not be parsed: ${(err as Error).message}`, { cause: err });
    }
  }
  const resolver = new TwxResolver(archive.objects, info, archive.lazy);

  // Objects rejected for a DOCTYPE, by name (from package.xml) and path; their content is never parsed or quoted.
  const label = (id: string) => {
    const name = info?.objects.get(id)?.name;
    return name ? `"${name}" (objects/${id}.xml)` : `objects/${id}.xml`;
  };
  const rejectedBpds: string[] = [];
  const rejectedOthers: string[] = [];
  for (const [id, xml] of archive.objects) {
    // BPDs are checked below, where a DOCTYPE in the embedded BPMN2 model is found as well.
    if (!id.startsWith('25.') && hasDoctype(xml)) rejectedOthers.push(label(id));
  }

  const processes: Process[] = [];
  for (const [id, xml] of archive.objects) {
    if (!id.startsWith('25.')) continue;
    let result;
    try {
      result = readBpd(xml, resolver, (other) => archive.objects.get(other));
    } catch (err) {
      if (err instanceof DoctypeError) rejectedBpds.push(label(id));
      else warnings.push(`Cannot read objects/${id}.xml: ${(err as Error).message}`);
      continue;
    }
    if (result.kind === 'rejected') {
      rejectedBpds.push(label(id));
    } else if (result.kind === 'process') {
      processes.push(result.process);
      warnings.push(...result.warnings);
    } else if (result.kind === 'skipped') {
      warnings.push(result.warning);
    }
    // Embedded (event) subprocess objects are drawn inside their parent BPD.
  }
  if (processes.length === 0 && rejectedBpds.length > 0) {
    throw new TwxReadError(doctypeOpenErrorMessage(rejectedBpds));
  }
  if (processes.length === 0) {
    throw new TwxReadError('The TWX export does not contain a business process definition (BPD) with a diagram.');
  }
  const rejected = [...rejectedBpds, ...rejectedOthers];
  if (rejected.length > 0) warnings.push(doctypeSkippedWarning(rejected, 'object'));
  await resolver.resolveControlTypes(resolver.readInternals());
  warnings.push(...resolver.warnings);
  processes.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const version = info?.buildVersion
    ? `${info.buildVersion}${info.fixPack ? `.${info.fixPack}` : ''}`
    : undefined;

  return {
    source: {
      path: archive.path,
      format: 'twx',
      bpmnFile: '',
      xsdFiles: [],
      exporter: 'IBM BAW',
      ...(version ? { exporterVersion: version } : {}),
      twx: {
        ...(info?.project.name ? { app: info.project.name } : {}),
        ...(info?.snapshot ? { snapshot: info.snapshot } : {}),
        toolkits: (info?.dependencies ?? []).map(dependencyLabel),
        packedToolkits: archive.toolkitEntries.length,
      },
    },
    processes,
    dataTypes: resolver.dataTypes(),
    warnings,
    calleeDiagrams: new TwxCalleeDiagrams(resolver),
  };
}
