import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_OFF, connectorOffBy, connectorOffVariable } from './connector-off.ts';

describe('connectorOffVariable', () => {
  it("names a connector's switch by its id in upper case, with _ for each - (T4766)", () => {
    assert.equal(connectorOffVariable('tracker'), 'TEAMRIG_CONNECTOR_TRACKER');
    assert.equal(connectorOffVariable('code-host-2'), 'TEAMRIG_CONNECTOR_CODE_HOST_2');
  });
});

describe('connectorOffBy', () => {
  it('names the variable that turns the connector off, in any case and with spaces around the value', () => {
    for (const value of [CONNECTOR_OFF, 'OFF', ' Off ']) {
      assert.equal(connectorOffBy({ TEAMRIG_CONNECTOR_TRACKER: value }, 'tracker'), 'TEAMRIG_CONNECTOR_TRACKER');
    }
  });

  it('leaves the connector on with no variable, another value, or the switch of another connector', () => {
    assert.equal(connectorOffBy({}, 'tracker'), undefined);
    for (const value of ['', 'on', '0', 'false', 'offline']) {
      assert.equal(connectorOffBy({ TEAMRIG_CONNECTOR_TRACKER: value }, 'tracker'), undefined);
    }
    assert.equal(connectorOffBy({ TEAMRIG_CONNECTOR_OTHER: 'off' }, 'tracker'), undefined);
    assert.equal(connectorOffBy({ TEAMRIG_CONNECTOR_TRACKER_2: 'off' }, 'tracker'), undefined);
  });

  it("takes a connector's older switch too, and names it first when both are set", () => {
    const older = ['TEAMRIG_TRACKER'];
    assert.equal(connectorOffBy({ TEAMRIG_TRACKER: 'off' }, 'tracker', older), 'TEAMRIG_TRACKER');
    assert.equal(connectorOffBy({ TEAMRIG_CONNECTOR_TRACKER: 'off' }, 'tracker', older), 'TEAMRIG_CONNECTOR_TRACKER');
    assert.equal(connectorOffBy({ TEAMRIG_TRACKER: 'off', TEAMRIG_CONNECTOR_TRACKER: 'off' }, 'tracker', older), 'TEAMRIG_TRACKER');
    assert.equal(connectorOffBy({ TEAMRIG_TRACKER: 'on', TEAMRIG_CONNECTOR_TRACKER: 'off' }, 'tracker', older), 'TEAMRIG_CONNECTOR_TRACKER');
    assert.equal(connectorOffBy({ TEAMRIG_TRACKER: 'off' }, 'tracker'), undefined);
  });
});
