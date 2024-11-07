import { parsePinnedRequirementsTree, mergeParsedRequirementsTree, compareSemVer } from './utils.js';

describe('parsePinnedRequirementsTree', () => {
  it('parses single dependency correctly', () => {
    const requirements = `\
        alembic==1.13.1
            # via flask-migrate`;
    expect(parsePinnedRequirementsTree(requirements)).toEqual({
      'flask-migrate': { deps: ['alembic'], version: null, vias: [] },
      alembic: { deps: [], version: '1.13.1', vias: ['flask-migrate'] },
    });
  });

  it('groups multiple dependencies under the same via', () => {
    const requirements = `
        alembic==1.13.1
            # via flask-migrate
        async-timeout==4.0.2
            # via flask-migrate
        `;
    expect(parsePinnedRequirementsTree(requirements)).toEqual({
      'flask-migrate': {
        deps: ['alembic', 'async-timeout'],
        version: null,
        vias: [],
      },
      alembic: { deps: [], version: '1.13.1', vias: ['flask-migrate'] },
      'async-timeout': { deps: [], version: '4.0.2', vias: ['flask-migrate'] },
    });
  });

  it('handles multiple vias for a single dependency', () => {
    const requirements = `
        attrs==23.1.0
            # via
            #   cattrs
            #   jsonschema
        `;
    expect(parsePinnedRequirementsTree(requirements)).toEqual({
      cattrs: { deps: ['attrs'], version: null, vias: [] },
      jsonschema: { deps: ['attrs'], version: null, vias: [] },
      attrs: { deps: [], version: '23.1.0', vias: ['cattrs', 'jsonschema'] },
    });
  });

  it('ignores lines without dependencies or via comments', () => {
    const requirements = `
        alembic==1.13.1
            # via flask-migrate`;
    expect(parsePinnedRequirementsTree(requirements)).toEqual({
      'flask-migrate': { deps: ['alembic'], version: null, vias: [] },
      alembic: { deps: [], version: '1.13.1', vias: ['flask-migrate'] },
    });
  });
  it('ignores lines with dash r', () => {
    const requirements = `
        # -r requirements.txt
        alembic==1.13.1
            # via flask-migrate`;
    expect(parsePinnedRequirementsTree(requirements)).toEqual({
      'flask-migrate': { deps: ['alembic'], version: null, vias: [] },
      alembic: { deps: [], version: '1.13.1', vias: ['flask-migrate'] },
    });
  });
});

describe('mergeParsedRequirementsTree', () => {
  it('merges non-overlapping keys correctly', () => {
    const obj1 = { 'flask-migrate': { deps: ['alembic'], version: '2.1.2' } };
    const obj2 = { paramiko: { deps: ['bcrypt'], version: '3.1.1' } };
    const expected = {
      'flask-migrate': {
        deps: ['alembic'],
        version: '2.1.2',
        vias: [],
      },
      paramiko: { deps: ['bcrypt'], version: '3.1.1', vias: [] },
    };
    expect(mergeParsedRequirementsTree(obj1, obj2)).toEqual(expected);
  });

  it('merges overlapping keys with unique dependencies correctly', () => {
    const obj1 = { 'flask-migrate': { deps: ['alembic'] } };
    const obj2 = { 'flask-migrate': { deps: ['async-timeout'] }, paramiko: { deps: ['bcrypt'] } };
    const expected = {
      'flask-migrate': { deps: ['alembic', 'async-timeout'], vias: [] },
      paramiko: { deps: ['bcrypt'], vias: [] },
    };
    expect(mergeParsedRequirementsTree(obj1, obj2)).toEqual(expected);
  });

  it('merges overlapping keys with duplicate dependencies correctly', () => {
    const obj1 = { 'flask-migrate': { deps: ['alembic', 'async-timeout'] } };
    const obj2 = { 'flask-migrate': { deps: ['alembic'] }, paramiko: { deps: ['bcrypt'] } };
    const expected = {
      'flask-migrate': { deps: ['alembic', 'async-timeout'], vias: [], version: undefined },
      paramiko: { deps: ['bcrypt'], vias: [], version: undefined },
    };
    expect(mergeParsedRequirementsTree(obj1, obj2)).toEqual(expected);
  });

  it('handles empty objects correctly', () => {
    const obj1 = {};
    const obj2 = { paramiko: { deps: ['bcrypt'] } };
    const expected = { paramiko: { deps: ['bcrypt'], vias: [] } };
    expect(mergeParsedRequirementsTree(obj1, obj2)).toEqual(expected);
  });
});

describe('SemVer Comparison', () => {
  test('correctly compares versions with leading zeros', () => {
    expect(compareSemVer('1.01.1', '1.1.2')).toBe(-1);
    expect(compareSemVer('1.1.01', '1.1.10')).toBe(-1);
    expect(compareSemVer('01.1.1', '1.1.1')).toBe(0);
  });

  test('handles large version numbers correctly', () => {
    expect(compareSemVer('1.2.3', '1.2.10')).toBe(-1);
    expect(compareSemVer('1.10.2', '1.9.3')).toBe(1);
    expect(compareSemVer('10.0.0', '2.10.10')).toBe(1);
  });

  test('compares versions where string comparison fails', () => {
    expect(compareSemVer('1.10.0', '1.2.0')).toBe(1);
    expect(compareSemVer('0.10.0', '0.9.0')).toBe(1);
    expect(compareSemVer('10.1.1', '2.2.2')).toBe(1);
    expect(compareSemVer('1.2.10', '1.2.2')).toBe(1);
  });

  test('handles versions with same major and minor but different patch versions', () => {
    expect(compareSemVer('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemVer('1.0.2', '1.0.2')).toBe(0);
    expect(compareSemVer('1.0.3', '1.0.1')).toBe(1);
  });

  test('handles versions with same major but different minor versions', () => {
    expect(compareSemVer('1.1.0', '1.2.0')).toBe(-1);
    expect(compareSemVer('1.2.0', '1.1.5')).toBe(1);
  });

  test('compares versions with different major versions', () => {
    expect(compareSemVer('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemVer('2.0.0', '1.10.10')).toBe(1);
  });
});
