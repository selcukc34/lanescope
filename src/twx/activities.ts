// Readers shared by the BPD reader and the service reader: the BPMN2
// elements a BPD (escaped bpmn2Data) and a service (real bpmn2Model or
// coachflow elements) write the same way. Verified on BAW 8.6.6 exports.
//
//   script task       scriptTask@scriptFormat, script (text as parsed, CRLF → LF)
//   call mappings     dataInputAssociation (targetRef = callee parameter id,
//                     assignment/from = value) and dataOutputAssociation
//                     (sourceRef, assignment/to = target); an unmapped
//                     parameter has no association at all. A literal is
//                     written ""text"" (mappingMode "literal"); a number as is.
//   parameters        ioSpecification dataInput / dataOutput
//   variables         dataObject

import type { DataMapping, DataParameter, ProcessVariable, Script } from '../model/model';
import type { CalleeInfo, TwxResolver } from './resolver';
import { attr, child, childText, children, textContent, type XmlElement } from './xml';

/** Children of process and subProcess that are not flow nodes. */
export const NON_FLOW_ELEMENTS = new Set([
  'documentation', 'extensionElements', 'ioSpecification', 'laneSet', 'dataObject', 'resourceRole',
  'incoming', 'outgoing', 'dataObjectReference', 'dataStoreReference', 'property', 'textAnnotation',
  'association', 'group', 'dataInput', 'dataOutput', 'inputSet', 'outputSet', 'dataInputAssociation',
  'dataOutputAssociation', 'standardLoopCharacteristics', 'multiInstanceLoopCharacteristics', 'auditing',
  'monitoring', 'htmlHeaderTag',
]);

/** Script text of a script task, as parsed: entities decoded, CRLF → LF, not trimmed. */
export function readScript(el: XmlElement): Script | undefined {
  const script = child(el, 'script');
  if (!script) return undefined;
  const text = textContent(script).replace(/\r\n?/g, '\n');
  if (text.trim().length === 0) return undefined;
  const language = attr(el, 'scriptFormat');
  return language ? { language, text } : { text };
}

export interface CallMappings {
  inputMappings?: DataMapping[];
  outputMappings?: DataMapping[];
}

/**
 * Data mappings of a call: one entry per parameter of the callee (mapped or
 * not), then any association to a parameter the signature does not list
 * (all of them when the callee is not in the export).
 */
export function readCallMappings(
  el: XmlElement,
  inputs: DataParameter[],
  outputs: DataParameter[],
  calleeKnown: boolean,
  label: string,
  warnings: string[],
): CallMappings {
  const out: CallMappings = {};
  const inputMappings = mappings(inputs, associations(el, 'input', label, warnings), calleeKnown, 'input', label, warnings);
  const outputMappings = mappings(outputs, associations(el, 'output', label, warnings), calleeKnown, 'output', label, warnings);
  if (inputMappings.length > 0) out.inputMappings = inputMappings;
  if (outputMappings.length > 0) out.outputMappings = outputMappings;
  return out;
}

interface Association {
  parameterId: string;
  value: string;
  literal: boolean;
  /** Parameter name from the other side of the assignment (tw.inputs.<name>, tw.outputs.<name>). */
  nameHint?: string;
}

const MAPPING_MODES = new Set(['simple', 'literal']);
/** A literal text mapping: two double quotes on each side. */
const QUOTED_LITERAL = /^""([\s\S]*)""$/;

function associations(el: XmlElement, direction: 'input' | 'output', label: string, warnings: string[]): Association[] {
  const tag = direction === 'input' ? 'dataInputAssociation' : 'dataOutputAssociation';
  const refTag = direction === 'input' ? 'targetRef' : 'sourceRef';
  const valueTag = direction === 'input' ? 'from' : 'to';
  const otherTag = direction === 'input' ? 'to' : 'from';
  const out: Association[] = [];
  for (const assoc of children(el, tag)) {
    const parameterId = childText(assoc, refTag);
    const assignments = children(assoc, 'assignment');
    const assignment = assignments[0];
    const valueEl = child(assignment, valueTag);
    if (!parameterId || assignments.length !== 1 || !valueEl) {
      warnings.push(`${label}: an ${direction} mapping of an unknown form is not shown.`);
      continue;
    }
    const mode = childText(child(assignment, 'extensionElements'), 'mappingMode');
    if (mode !== undefined && !MAPPING_MODES.has(mode)) {
      warnings.push(`${label}: the ${direction} mapping of parameter ${parameterId} has the unknown mapping mode "${mode}" and is not shown.`);
      continue;
    }
    const raw = textContent(valueEl).trim();
    if (raw.length === 0) {
      warnings.push(`${label}: the ${direction} mapping of parameter ${parameterId} is empty.`);
    }
    const quoted = direction === 'input' ? QUOTED_LITERAL.exec(raw) : null;
    const other = child(assignment, otherTag);
    const hint = other
      ? new RegExp(`^tw\\.${direction === 'input' ? 'inputs' : 'outputs'}\\.([A-Za-z_$][\\w$]*)$`).exec(textContent(other).trim())
      : null;
    out.push({
      parameterId,
      value: quoted ? quoted[1] : raw,
      literal: quoted !== null || mode === 'literal',
      ...(hint ? { nameHint: hint[1] } : {}),
    });
  }
  return out;
}

function mappings(
  params: DataParameter[],
  assocs: Association[],
  calleeKnown: boolean,
  direction: 'input' | 'output',
  label: string,
  warnings: string[],
): DataMapping[] {
  const byId = new Map<string, Association>();
  for (const a of assocs) {
    if (byId.has(a.parameterId)) {
      warnings.push(`${label}: parameter ${a.parameterId} has more than one ${direction} mapping; only the first is shown.`);
      continue;
    }
    byId.set(a.parameterId, a);
  }
  const used = new Set<string>();
  const out: DataMapping[] = params.map((p) => {
    const a = byId.get(p.id);
    const parameter = p.name || p.id;
    if (!a) return { parameterId: p.id, parameter, mapped: false, literal: false };
    used.add(p.id);
    return { parameterId: p.id, parameter, value: a.value, mapped: true, literal: a.literal };
  });
  for (const [id, a] of byId) {
    if (used.has(id)) continue;
    if (calleeKnown) {
      warnings.push(`${label}: the ${direction} mapping of parameter ${id} names no ${direction} of the called element.`);
    }
    out.push({ parameterId: id, parameter: a.nameHint ?? id, value: a.value, mapped: true, literal: a.literal });
  }
  return out;
}

/** The inputs or outputs of a callee's signature, as data parameters. */
export function parametersOf(callee: CalleeInfo, direction: 'input' | 'output'): DataParameter[] {
  return callee.parameters
    .filter((p) => p.direction === direction)
    .map((p) => {
      const param: DataParameter = { id: p.id, name: p.name, isCollection: p.isList };
      if (p.typeRef) param.typeRef = p.typeRef;
      if (p.typeName) param.typeName = p.typeName;
      return param;
    });
}

/** dataInput / dataOutput of an ioSpecification. */
export function dataParameter(el: XmlElement, resolver: TwxResolver): DataParameter {
  const param: DataParameter = {
    id: attr(el, 'id') ?? '',
    name: el.attrs.name ?? '',
    isCollection: attr(el, 'isCollection') === 'true',
  };
  const typeRef = attr(el, 'itemSubjectRef');
  if (typeRef) {
    param.typeRef = typeRef;
    const typeName = resolver.typeName(typeRef);
    if (typeName) param.typeName = typeName;
  }
  return param;
}

/** Inputs and outputs of the ioSpecification directly below `container`. */
export function ioParameters(container: XmlElement, resolver: TwxResolver): { inputs: DataParameter[]; outputs: DataParameter[] } {
  const io = child(container, 'ioSpecification');
  return {
    inputs: children(io, 'dataInput').map((p) => dataParameter(p, resolver)),
    outputs: children(io, 'dataOutput').map((p) => dataParameter(p, resolver)),
  };
}

/**
 * A dataObject as a variable: type, list, and the default value and tracking
 * its own extensionElements hold. The BPD reader overrides both from the
 * classic model when that has the variable.
 */
export function dataObjectVariable(obj: XmlElement, resolver: TwxResolver): ProcessVariable {
  const extensions = child(obj, 'extensionElements');
  const variable: ProcessVariable = {
    name: obj.attrs.name ?? '',
    isCollection: attr(obj, 'isCollection') === 'true',
    tracked: child(extensions, 'trackedField') !== undefined,
  };
  const typeRef = attr(obj, 'itemSubjectRef');
  if (typeRef) {
    variable.typeRef = typeRef;
    const typeName = resolver.typeName(typeRef);
    if (typeName) variable.typeName = typeName;
  }
  const def = child(extensions, 'defaultValue');
  if (def && attr(def, 'useDefault') === 'true') variable.defaultValue = textContent(def).trim();
  return variable;
}
