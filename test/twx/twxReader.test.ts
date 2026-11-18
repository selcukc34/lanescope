import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readTwxArchive } from '../../src/twx/twxReader';
import { readPackageXml } from '../../src/twx/packageXml';
import { parseXml } from '../../src/twx/xml';
import { docText } from '../../src/twx/text';
import { localRef, TwxResolver } from '../../src/twx/resolver';

const PACKAGE = `<?xml version="1.0" encoding="UTF-8"?>
<p:package buildVersion="8.6.6" fixPack="23020" xmlns:p="http://lombardisoftware.com/schema/teamworks/7.0.0/package.xsd">
  <target>
    <project id="2066.a" name="My App" shortName="MA" isToolkit="false" isSystem="false"/>
    <branch id="2063.b" name="Main"/>
    <snapshot id="2064.c" name="1.0"/>
  </target>
  <dependencies>
    <dependency rank="0" id="2069.4a3cac48-f159-4406-bd35-a23dc495d265">
      <project id="2066.d" name="System Data" shortName="TWSYS" isToolkit="true" isSystem="true"/>
      <snapshot id="2064.e" name="8.6.0.0"/>
    </dependency>
  </dependencies>
  <objects>
    <object id="1.svc" name="Declared Service" type="process"/>
    <object id="12.bo" name="Customer" type="twClass"/>
  </objects>
</p:package>`;

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('readTwxArchive', () => {
  it('reads package.xml and the BPD, service and business object files only', async () => {
    const data = await zipOf({
      'META-INF/package.xml': PACKAGE,
      'META-INF/metadata.xml': '<metadata/>',
      'objects/25.bpd.xml': '<teamworks/>',
      'objects/1.svc.xml': '<teamworks/>',
      'objects/12.bo.xml': '<teamworks/>',
      'objects/64.view.xml': '<teamworks/>',
      'files/61.x/y': 'binary',
      'toolkits/2064.e.zip': 'not read',
    });
    const archive = await readTwxArchive(data, 'app.twx');
    expect(archive.packageXml).toBe(PACKAGE);
    expect([...archive.objects.keys()].sort()).toEqual(['1.svc', '12.bo', '25.bpd']);
    expect(archive.toolkitEntries).toEqual(['toolkits/2064.e.zip']);
    expect(archive.warnings).toEqual([]);
  });

  it('reads other objects and the package.xml of packed toolkits only on demand', async () => {
    const toolkitPackage = '<p:package xmlns:p="x"><objects><object id="64.t" name="Table" type="coachView"/></objects></p:package>';
    const toolkit = new JSZip();
    toolkit.file('objects/64.t.xml', '<teamworks/>');
    toolkit.file('META-INF/package.xml', toolkitPackage);
    const zip = new JSZip();
    zip.file('META-INF/package.xml', PACKAGE);
    zip.file('objects/64.view.xml', '<teamworks><coachView id="64.view" name="My View"/></teamworks>');
    zip.file('toolkits/2064.e.zip', await toolkit.generateAsync({ type: 'uint8array' }));
    zip.file('toolkits/2064.f.zip', 'not a zip');
    const archive = await readTwxArchive(await zip.generateAsync({ type: 'uint8array' }), 'app.twx');
    expect(archive.objects.has('64.view')).toBe(false);
    expect(await archive.lazy!.readObject('64.view')).toContain('My View');
    expect(await archive.lazy!.readObject('64.none')).toBeUndefined();
    const first = archive.lazy!.toolkitPackages();
    expect(archive.lazy!.toolkitPackages()).toBe(first); // read once, cached
    const { packages, warnings } = await first;
    expect(packages).toEqual([toolkitPackage]);
    expect(warnings).toEqual(['The packed toolkit toolkits/2064.f.zip could not be read (not a valid zip archive); names from it are not shown.']);
  });

  it('skips entries with unsafe paths and says so', async () => {
    const data = await zipOf({
      'META-INF/package.xml': PACKAGE,
      '../objects/25.evil.xml': '<teamworks/>',
      'objects/../25.evil2.xml': '<teamworks/>',
    });
    const archive = await readTwxArchive(data, 'app.twx');
    expect(archive.objects.size).toBe(0);
    expect(archive.warnings).toHaveLength(2);
    expect(archive.warnings[0]).toMatch(/unsafe path/);
  });

  it('rejects more entries than the limit', async () => {
    const files: Record<string, string> = { 'META-INF/package.xml': PACKAGE };
    for (let i = 0; i < 10; i++) files[`objects/64.v${i}.xml`] = '';
    await expect(readTwxArchive(await zipOf(files), 'a.twx', { maxEntries: 5 })).rejects.toThrow(
      /entries; the limit is 5/,
    );
  });

  it('rejects an entry larger than the per-entry limit', async () => {
    const data = await zipOf({ 'META-INF/package.xml': PACKAGE, 'objects/25.big.xml': 'a'.repeat(10_000) });
    await expect(readTwxArchive(data, 'a.twx', { maxEntryBytes: 5_000 })).rejects.toThrow(
      /larger than 5000 bytes when uncompressed/,
    );
  });

  it('rejects content larger than the total limit', async () => {
    const data = await zipOf({ 'META-INF/package.xml': PACKAGE, 'objects/25.big.xml': 'a'.repeat(10_000) });
    await expect(readTwxArchive(data, 'a.twx', { maxTotalUncompressedBytes: 5_000 })).rejects.toThrow(
      /larger than 5000 bytes when uncompressed/,
    );
  });

  it('rejects data that is not a zip, and a zip that is not a TWX', async () => {
    await expect(readTwxArchive(new TextEncoder().encode('not a zip'), 'a.twx')).rejects.toThrow(
      /not a valid TWX\/zip archive/,
    );
    await expect(readTwxArchive(await zipOf({ 'readme.txt': 'x' }), 'a.twx')).rejects.toThrow(
      /Is this a TWX export\?/,
    );
  });
});

describe('readPackageXml', () => {
  it('reads the app, its dependencies and the declared objects', () => {
    const info = readPackageXml(PACKAGE);
    expect(info.project).toMatchObject({ name: 'My App', shortName: 'MA', isToolkit: false });
    expect(info).toMatchObject({ branch: 'Main', snapshot: '1.0', buildVersion: '8.6.6', fixPack: '23020' });
    expect(info.dependencies).toEqual([
      {
        prefix: '4a3cac48-f159-4406-bd35-a23dc495d265',
        projectId: '2066.d',
        name: 'System Data',
        shortName: 'TWSYS',
        snapshotId: '2064.e',
        snapshotName: '8.6.0.0',
        isSystem: true,
      },
    ]);
    expect(info.objects.get('12.bo')).toMatchObject({ name: 'Customer', type: 'twClass' });
  });
});

describe('parseXml', () => {
  it('rejects documents with a DOCTYPE (no entity expansion)', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>';
    expect(() => parseXml(xml)).toThrow(/DOCTYPE/);
  });

  it('keeps document order, local names and untrimmed attribute values', () => {
    const root = parseXml('<ns:a xmlns:ns="u"><ns:b name="x "/><ns:c>t&amp;u</ns:c><ns:b name="y"/></ns:a>');
    expect(root.name).toBe('a');
    expect(root.children.map((c) => `${c.name}:${c.attrs.name ?? c.text}`)).toEqual(['b:x ', 'c:t&u', 'b:y']);
  });
});

describe('docText', () => {
  it('drops the HTML wrapper BAW puts around documentation', () => {
    expect(docText('<html><body>Routes when amount > 10000.</body></html>')).toBe('Routes when amount > 10000.');
    expect(docText('<p>One</p><p>Two &amp; three</p>')).toBe('One\nTwo & three');
    expect(docText('tw.local.amount < 1000')).toBe('tw.local.amount < 1000');
    expect(docText('<html><body></body></html>')).toBeUndefined();
    expect(docText(undefined)).toBeUndefined();
  });
});

describe('TwxResolver', () => {
  const service = `<teamworks><process id="1.svc" name="Validate">
    <processType>12</processType>
    <processParameter name="result"><processParameterId>2055.out</processParameterId><parameterType>2</parameterType>
      <isArrayOf>true</isArrayOf><classId>4a3c/12.db884a3c-c533-44b7-bb2d-47bec8ad4022</classId><seq>2</seq></processParameter>
    <processParameter name="customer"><processParameterId>2055.in</processParameterId><parameterType>1</parameterType>
      <isArrayOf>false</isArrayOf><classId>/12.bo</classId><seq>1</seq></processParameter>
  </process></teamworks>`;
  const bo = `<teamworks><twClass id="12.bo" name="Customer"><description>&lt;html&gt;&lt;body&gt;A customer&lt;/body&gt;&lt;/html&gt;</description>
    <definition><property><name>age</name><classRef>4a3c/12.3fa0d7a0-828a-4d60-99cc-db5ed143fc2d</classRef>
      <arrayProperty>false</arrayProperty><propertyRequired>true</propertyRequired></property></definition>
  </twClass></teamworks>`;
  const resolver = new TwxResolver(
    new Map([
      ['1.svc', service],
      ['12.bo', bo],
    ]),
    readPackageXml(PACKAGE),
  );

  it('normalises references', () => {
    expect(localRef('4a3c/12.x')).toBe('12.x');
    expect(localRef('/1.y')).toBe('1.y');
    expect(localRef('itm.12.z')).toBe('12.z');
  });

  it('resolves a service with its signature in seq order', () => {
    expect(resolver.callee('/1.svc')).toEqual({
      id: '1.svc',
      name: 'Validate',
      kind: 'Service flow',
      processType: '12',
      generated: false,
      parameters: [
        { id: '2055.in', name: 'customer', direction: 'input', typeRef: '/12.bo', typeName: 'Customer', isList: false },
        {
          id: '2055.out',
          name: 'result',
          direction: 'output',
          typeRef: '4a3c/12.db884a3c-c533-44b7-bb2d-47bec8ad4022',
          typeName: 'String',
          isList: true,
        },
      ],
    });
    expect(resolver.callee('1.missing')).toBeUndefined();
  });

  it('maps business objects to data types', () => {
    expect(resolver.dataTypes()).toEqual([
      {
        name: 'Customer',
        documentation: 'A customer',
        fields: [{ name: 'age', type: 'Integer', required: true, list: false }],
      },
    ]);
  });
});
