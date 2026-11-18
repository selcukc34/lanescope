import { describe, expect, it } from 'vitest';
import { readBpmn } from '../../src/bpmn/bpmnReader';

const NS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:ibm="http://www.ibm.com/xmlns/prod/websphere/ibmbpm/pal/bpmnextension"`;

describe('readBpmn', () => {
  it('does not warn about the harmless implementation="##unspecified" on a task, but about other unknown attributes', async () => {
    const xml = `<bpmn:definitions ${NS} id="d">
      <bpmn:process id="p">
        <bpmn:task id="t1" name="A" implementation="##unspecified"/>
        <bpmn:task id="t2" name="B" implementation="##WebService"/>
        <bpmn:task id="t3" name="C" implementation="com.example.Impl"/>
        <bpmn:task id="t4" name="D" colour="red"/>
      </bpmn:process>
    </bpmn:definitions>`;
    const { warnings } = await readBpmn(xml);
    expect(warnings).toEqual(['unknown attribute <implementation>', 'unknown attribute <colour>']);
  });

  it('keeps unrecognised elements as kind "unknown" with their original type', async () => {
    const xml = `<bpmn:definitions ${NS} id="d">
      <bpmn:process id="p">
        <bpmn:laneSet id="ls"><bpmn:lane id="l" name="L">
          <bpmn:flowNodeRef>s</bpmn:flowNodeRef><bpmn:flowNodeRef>x</bpmn:flowNodeRef><bpmn:flowNodeRef>st</bpmn:flowNodeRef>
        </bpmn:lane></bpmn:laneSet>
        <bpmn:startEvent id="s"/>
        <bpmn:fancyTask id="x" name="Fancy"><bpmn:documentation>Doc</bpmn:documentation></bpmn:fancyTask>
        <bpmn:scriptTask id="st" name="Script"/>
        <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="x"/>
        <bpmn:sequenceFlow id="f2" sourceRef="x" targetRef="st"/>
      </bpmn:process>
    </bpmn:definitions>`;
    const result = await readBpmn(xml);
    const [p] = result.processes;
    const kinds = Object.fromEntries(p.nodes.map((n) => [n.id, [n.kind, n.originalType]]));
    expect(kinds).toEqual({
      s: ['startEvent', 'bpmn:StartEvent'],
      st: ['scriptTask', 'bpmn:ScriptTask'],
      x: ['unknown', 'bpmn:fancyTask'],
    });
    expect(p.nodes.find((n) => n.id === 'x')).toMatchObject({ name: 'Fancy', documentation: 'Doc', laneId: 'l' });
    expect(p.lanes[0].nodeIds).toEqual(['s', 'x', 'st']);
    expect(p.flows.map((f) => [f.sourceId, f.targetId])).toEqual([
      ['s', 'x'],
      ['x', 'st'],
    ]);
    expect(result.warnings.some((w) => w.includes('bpmn:fancyTask'))).toBe(true);
  });

  it('reads a bpmn:scriptTask as a script task with its script and scriptFormat', async () => {
    const xml = `<bpmn:definitions ${NS} id="d"><bpmn:process id="p">
      <bpmn:scriptTask id="st" name="Decide" scriptFormat="text/x-javascript"><bpmn:script>if (tw.local.a &lt; 1) {\r\n  tw.local.b = "x &amp; y";\r\n}\r\n</bpmn:script></bpmn:scriptTask>
      <bpmn:scriptTask id="empty" name="No script"/>
    </bpmn:process></bpmn:definitions>`;
    const result = await readBpmn(xml);
    const [p] = result.processes;
    expect(p.nodes[0]).toMatchObject({
      kind: 'scriptTask',
      originalType: 'bpmn:ScriptTask',
      script: { language: 'text/x-javascript', text: 'if (tw.local.a < 1) {\n  tw.local.b = "x & y";\n}\n' },
    });
    expect(p.nodes[1].kind).toBe('scriptTask');
    expect(p.nodes[1].script).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('reads icp:serviceType whatever prefix the namespace is bound to', async () => {
    const xml = `<bpmn:definitions ${NS} id="d"><bpmn:process id="p">
      <bpmn:task id="t" ibm:serviceType="ServiceFlow"/></bpmn:process></bpmn:definitions>`;
    const [p] = (await readBpmn(xml)).processes;
    expect(p.nodes[0]).toMatchObject({ kind: 'task', serviceType: 'ServiceFlow' });
  });

  it('keeps bpmndi bounds when present', async () => {
    const xml = `<bpmn:definitions ${NS} id="d">
      <bpmn:process id="p"><bpmn:startEvent id="s"/><bpmn:fancyTask id="x"/></bpmn:process>
      <bpmndi:BPMNDiagram id="dg"><bpmndi:BPMNPlane id="pl" bpmnElement="p">
        <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="10" y="20" width="36" height="36"/></bpmndi:BPMNShape>
        <bpmndi:BPMNShape id="x_di" bpmnElement="x"><dc:Bounds x="100" y="20" width="100" height="80"/></bpmndi:BPMNShape>
      </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
    </bpmn:definitions>`;
    const [p] = (await readBpmn(xml)).processes;
    expect(p.nodes.find((n) => n.id === 's')?.bounds).toEqual({ x: 10, y: 20, width: 36, height: 36 });
    expect(p.nodes.find((n) => n.id === 'x')?.bounds).toEqual({ x: 100, y: 20, width: 100, height: 80 });
  });

  it('flattens sub-process children with a parentId', async () => {
    const xml = `<bpmn:definitions ${NS} id="d"><bpmn:process id="p">
      <bpmn:subProcess id="sp"><bpmn:startEvent id="inner"/></bpmn:subProcess></bpmn:process></bpmn:definitions>`;
    const [p] = (await readBpmn(xml)).processes;
    expect(p.nodes.map((n) => [n.id, n.kind, n.parentId])).toEqual([
      ['sp', 'subProcess', undefined],
      ['inner', 'startEvent', 'sp'],
    ]);
  });

  it('rejects documents that are not BPMN', async () => {
    await expect(readBpmn('<foo/>')).rejects.toThrow(/Invalid BPMN/);
  });
});
