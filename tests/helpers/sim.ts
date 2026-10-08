/** Headless simulation helpers shared by physics tests. */
import { Vector3 } from 'three';
import { FlightModel, type WorldQuery } from '../../src/physics/FlightModel';
import { FlightControlSystem, type PilotInput } from '../../src/physics/FlightControls';
import { getAircraft } from '../../src/aircraft/specs';

export const DT = 1 / 240;

export function flatWorld(height = 0): WorldQuery {
  return {
    groundHeight: () => height,
    isWater: () => false,
    surfaceType: () => 'runway',
  };
}

export interface Rig {
  model: FlightModel;
  fcs: FlightControlSystem;
  world: WorldQuery;
  wind: Vector3;
  events: string[];
  time: number;
  /** Run for `seconds`, calling `pilot` every step to produce inputs. */
  run(seconds: number, pilot?: (r: Rig) => Partial<PilotInput> & { throttle?: number; brake?: number }): void;
}

export function makeRig(id: string, assist: 'easy' | 'realistic' = 'realistic', world = flatWorld()): Rig {
  const model = new FlightModel(getAircraft(id));
  const fcs = new FlightControlSystem();
  fcs.assist = assist;
  const events: string[] = [];
  model.onEvent = (e) => events.push(e.type === 'crash' ? `crash:${e.reason}` : e.type);
  const rig: Rig = {
    model,
    fcs,
    world,
    wind: new Vector3(),
    events,
    time: 0,
    run(seconds, pilot) {
      const steps = Math.round(seconds / DT);
      for (let i = 0; i < steps && !model.crashed; i++) {
        const inp = pilot ? pilot(rig) : {};
        if (inp.throttle !== undefined) model.throttle = inp.throttle;
        if (inp.brake !== undefined) model.brake = inp.brake;
        const pin: PilotInput = { pitch: inp.pitch ?? 0, roll: inp.roll ?? 0, yaw: inp.yaw ?? 0 };
        const cmd = fcs.update(model, pin, DT);
        if (fcs.autopilot.engaged && fcs.autopilot.autothrottle) model.throttle = fcs.apThrottle;
        model.step(DT, cmd, world, rig.wind, pin.yaw);
        rig.time += DT;
      }
    },
  };
  return rig;
}
