import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolAggregator } from "./aggregator.js";

import {
  AggregatedToolResolver,
} from "./resolver.js";

import type {
  UpstreamRegistry,
} from "../upstream/registry.js";

import type {
  UpstreamState,
} from "../upstream/types.js";

function createState(
  name: string,
  status: UpstreamState["status"],
  toolNames: string[],
): UpstreamState {
  return {
    config: {
      name,
      url: `http://${name}:3000/mcp`,
      enabled: status !== "disabled",
    },

    status,
    client: null,

    tools: toolNames.map((toolName) => ({
      name: toolName,

      description: `${toolName} description`,

      inputSchema: {
        type: "object",
        properties: {},
      },
    })),

    lastConnectedAt: null,
    lastDiscoveredAt: null,
    lastError: null,
  };
}

function createMockRegistry(
  states: UpstreamState[],
): UpstreamRegistry {
  return {
    list: () => states,
  } as unknown as UpstreamRegistry;
}

test("aggregates and namespaces tools", () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "calculate",
    ]),

    createState("time", "connected", [
      "current",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  const names = aggregator.listTools().map(
    (tool) => tool.name,
  );

  assert.deepEqual(names, [
    "calculator.calculate",
    "time.current",
  ]);
});

test("allows identical original names across upstreams", () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "status",
    ]),

    createState("time", "connected", [
      "status",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  const names = aggregator.listTools().map(
    (tool) => tool.name,
  );

  assert.deepEqual(names, [
    "calculator.status",
    "time.status",
  ]);
});

test("excludes unavailable upstreams", () => {
  const registry = createMockRegistry([
    createState("calculator", "unreachable", [
      "calculate",
    ]),

    createState("time", "connected", [
      "current",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  assert.deepEqual(
    aggregator.listTools().map(
      (tool) => tool.name,
    ),
    ["time.current"],
  );
});

test("excludes disabled upstreams", () => {
  const registry = createMockRegistry([
    createState("calculator", "disabled", [
      "calculate",
    ]),

    createState("time", "connected", [
      "current",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  assert.equal(
    aggregator.getTool("calculator.calculate"),
    null,
  );
});

test("resolves public names to original upstream tools", async () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "calculate",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  const resolver = new AggregatedToolResolver(
    aggregator,
  );

  const resolved = await resolver.resolve(
    "calculator.calculate",
  );

  assert.deepEqual(resolved, {
    publicName: "calculator.calculate",
    upstreamName: "calculator",
    upstreamToolName: "calculate",
  });
});

test("rejects unknown tools", async () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "calculate",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  const resolver = new AggregatedToolResolver(
    aggregator,
  );

  assert.equal(
    await resolver.resolve(
      "calculator.delete_everything",
    ),
    null,
  );
});

test("rejects duplicate public names", () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "calculate",
      "calculate",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  assert.throws(
    () => aggregator.listTools(),
    /Tool name collision/,
  );
});

test("preserves tool descriptions and schemas", () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "calculate",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  const tool = aggregator.getTool(
    "calculator.calculate",
  );

  assert.equal(
    tool?.description,
    "calculate description",
  );

  assert.deepEqual(tool?.inputSchema, {
    type: "object",
    properties: {},
  });
});