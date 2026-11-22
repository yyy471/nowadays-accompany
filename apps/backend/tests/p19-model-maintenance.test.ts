import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveClaimedModelBinding,
  type ModelCallClaim,
  type ModelMaintenanceGate,
} from "../src/application/model-maintenance.js";

/** 可逐次放行的维护门：每次 wait 记录资源并等测试放行。 */
function gated(resources: string[]): {
  gate: ModelMaintenanceGate;
  waits: string[];
  releaseNext: () => void;
  setUnder: (ids: string[]) => void;
} {
  let under = new Set(resources);
  const waits: string[] = [];
  const pending: Array<() => void> = [];
  return {
    waits,
    gate: {
      isUnder: (resourceId) => under.has(resourceId),
      wait: (resourceId) => {
        waits.push(resourceId);
        return new Promise<void>((resolve) => pending.push(resolve));
      },
    },
    releaseNext: () => pending.shift()?.(),
    setUnder: (ids) => {
      under = new Set(ids);
    },
  };
}

function admitAll(): ModelCallClaim {
  return { admitted: true, release: () => undefined };
}

test("等待结束后的改绑会检查新服务的维护状态", async () => {
  const state = gated(["a"]);
  const bindings = [{ resourceId: "a" }, { resourceId: "b" }];
  let index = 0;
  const resolved = resolveClaimedModelBinding(
    () => bindings[Math.min(index++, bindings.length - 1)]!,
    state.gate,
    admitAll,
  );
  await Promise.resolve();
  assert.deepEqual(state.waits, ["a"]);
  // 放行 A 的同时让 B 也进入维护。
  state.setUnder(["b"]);
  state.releaseNext();
  await Promise.resolve();
  assert.deepEqual(state.waits, ["a", "b"]);
  state.setUnder([]);
  state.releaseNext();
  assert.deepEqual((await resolved)?.binding, { resourceId: "b" });
});

test("最后一次检查之后才进入维护时，领取失败并继续等待", async () => {
  const state = gated([]);
  let rejectOnce = true;
  const resolved = resolveClaimedModelBinding(
    () => ({ resourceId: "a" }),
    state.gate,
    () => {
      if (rejectOnce) {
        // 模拟检查通过后、领取前插入的维护窗口。
        rejectOnce = false;
        state.setUnder(["a"]);
        return { admitted: false, release: () => undefined };
      }
      return admitAll();
    },
  );
  await Promise.resolve();
  assert.deepEqual(state.waits, ["a"], "领取被拒绝后应等待维护结束");
  state.setUnder([]);
  state.releaseNext();
  assert.deepEqual((await resolved)?.binding, { resourceId: "a" });
});

test("同一服务连续维护时持续等待到真正结束", async () => {
  const state = gated(["a"]);
  const resolved = resolveClaimedModelBinding(
    () => ({ resourceId: "a" }),
    state.gate,
    admitAll,
  );
  await Promise.resolve();
  assert.deepEqual(state.waits, ["a"]);
  // 第一次放行时维护窗口又续上了。
  state.releaseNext();
  await Promise.resolve();
  assert.deepEqual(state.waits, ["a", "a"]);
  state.setUnder([]);
  state.releaseNext();
  assert.deepEqual((await resolved)?.binding, { resourceId: "a" });
});

test("等待期间取消会停止领取调用", async () => {
  const state = gated(["a"]);
  const controller = new AbortController();
  let claims = 0;
  const resolved = resolveClaimedModelBinding(
    () => ({ resourceId: "a" }),
    state.gate,
    () => {
      claims += 1;
      return admitAll();
    },
    controller.signal,
  );
  await Promise.resolve();
  assert.deepEqual(state.waits, ["a"]);
  controller.abort();
  state.releaseNext();
  assert.equal(await resolved, null);
  assert.equal(claims, 0, "取消后不得领取调用");
});

test("不在维护中的目标直接领取且不等待", async () => {
  const state = gated([]);
  let released = 0;
  const claimed = await resolveClaimedModelBinding(
    () => ({ resourceId: "a" }),
    state.gate,
    () => ({ admitted: true, release: () => { released += 1; } }),
  );
  assert.deepEqual(claimed?.binding, { resourceId: "a" });
  claimed?.release();
  assert.equal(released, 1);
  assert.deepEqual(state.waits, []);
});
