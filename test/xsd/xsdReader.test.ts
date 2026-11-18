import { describe, expect, it } from 'vitest';
import { readXsd } from '../../src/xsd/xsdReader';

describe('readXsd', () => {
  it('maps occurrence constraints, choices, extensions and attributes', () => {
    const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t">
      <xs:complexType name="Base">
        <xs:sequence><xs:element name="id" type="xs:string"/></xs:sequence>
      </xs:complexType>
      <xs:complexType name="Order">
        <xs:annotation><xs:documentation> An order. </xs:documentation></xs:annotation>
        <xs:complexContent><xs:extension base="t:Base">
          <xs:sequence>
            <xs:element name="lines" type="t:Line" minOccurs="0" maxOccurs="unbounded"/>
            <xs:element name="tags" type="xs:string" maxOccurs="5"/>
            <xs:choice><xs:element name="a" type="xs:int"/><xs:element name="b" type="xs:int"/></xs:choice>
          </xs:sequence>
          <xs:attribute name="version" type="xs:int" use="required"/>
        </xs:extension></xs:complexContent>
      </xs:complexType>
    </xs:schema>`;
    const order = readXsd(xsd).find((t) => t.name === 'Order')!;
    expect(order.namespace).toBe('urn:t');
    expect(order.documentation).toBe('An order.');
    expect(order.fields).toEqual([
      { name: 'id', type: 'string', required: true, list: false },
      { name: 'lines', type: 'Line', required: false, list: true },
      { name: 'tags', type: 'string', required: true, list: true },
      { name: 'a', type: 'int', required: false, list: false },
      { name: 'b', type: 'int', required: false, list: false },
      { name: 'version', type: 'int', required: true, list: false },
    ]);
  });

  it('rejects documents without a schema root', () => {
    expect(() => readXsd('<foo/>')).toThrow(/xs:schema/);
  });
});
