// Minimal typings for the bpmn-moddle entry point, whose package exports
// only ship generated element types (bpmn-moddle/types), not the factory.
declare module 'bpmn-moddle' {
  export interface ModdleElement {
    $type: string;
    $attrs?: Record<string, string>;
    $parent?: ModdleElement;
    $instanceOf(type: string): boolean;
    get(name: string): unknown;
    set(name: string, value: unknown): void;
    [key: string]: unknown;
  }

  export interface ParseResult {
    rootElement: ModdleElement;
    references: unknown[];
    warnings: Array<Error & { element?: ModdleElement; property?: string; value?: unknown }>;
    elementsById: Record<string, ModdleElement>;
  }

  export interface BpmnModdleInstance {
    fromXML(xml: string, typeName?: string, options?: Record<string, unknown>): Promise<ParseResult>;
    fromXML(xml: string, options?: Record<string, unknown>): Promise<ParseResult>;
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    toXML(element: ModdleElement, options?: { format?: boolean; preamble?: boolean }): Promise<{ xml: string }>;
  }

  export function BpmnModdle(
    additionalPackages?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): BpmnModdleInstance;
}
