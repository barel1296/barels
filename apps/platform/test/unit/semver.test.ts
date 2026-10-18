import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareSemver, isValidRange, maxSatisfying, parseSemver, satisfies } from '../../src/lib/semver.js';

describe('workflow version ranges', () => {
  it('parses SemVer and orders prereleases below releases', () => {
    const v = (s: string) => parseSemver(s)!;
    assert.equal(parseSemver('01.0.0'), null);
    assert.ok(compareSemver(v('1.2.3-rc.1'), v('1.2.3')) < 0);
    assert.ok(compareSemver(v('1.2.3-rc.2'), v('1.2.3-rc.10')) < 0);
    assert.ok(compareSemver(v('1.10.0'), v('1.9.9')) > 0);
  });
  it('caret ranges never cross a MAJOR; tilde ranges never cross a MINOR', () => {
    assert.ok(satisfies('1.4.0', '^1.2'));
    assert.ok(!satisfies('2.0.0', '^1.2'));
    assert.ok(!satisfies('1.1.9', '^1.2'));
    assert.ok(satisfies('1.2.9', '~1.2.3'));
    assert.ok(!satisfies('1.3.0', '~1.2'));
  });
  it('prereleases are selected only by exact versions', () => {
    assert.ok(!satisfies('1.3.0-beta.1', '^1.2'));
    assert.ok(satisfies('1.3.0-beta.1', '1.3.0-beta.1'));
    assert.equal(isValidRange('^1.2.0-beta'), false);
  });
  it('maxSatisfying picks the highest matching version', () => {
    assert.equal(maxSatisfying(['1.0.0', '1.2.0', '1.10.1', '2.0.0'], '^1.0'), '1.10.1');
    assert.equal(maxSatisfying(['2.0.0'], '^1.0'), null);
  });
  it('rejects malformed ranges', () => {
    for (const r of ['>=1.0.0', '1.x', '^1', 'latest', '']) assert.equal(isValidRange(r), false, r);
  });
});
