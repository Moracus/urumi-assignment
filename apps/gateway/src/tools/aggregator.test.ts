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
    generation: 1,
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
    "calculator_calculate",
    "time_current",
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
    "calculator_status",
    "time_status",
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
    ["time_current"],
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
    aggregator.getTool("calculator_calculate"),
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
    "calculator_calculate",
  );

  assert.deepEqual(resolved, {
    generation: 1,
    publicName: "calculator_calculate",
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
      "calculator_delete_everything",
    ),
    null,
  );
});

test("omits duplicate public names", () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "calculate",
      "calculate",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  assert.deepEqual(aggregator.listTools(), []);
});

test("preserves tool descriptions and schemas", () => {
  const registry = createMockRegistry([
    createState("calculator", "connected", [
      "calculate",
    ]),
  ]);

  const aggregator = new ToolAggregator(registry);

  const tool = aggregator.getTool(
    "calculator_calculate",
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

test("rejects ambiguous underscore mappings without hiding healthy tools", async () => {
  for (const status of ["connected", "unreachable"] as const) {
    const registry = createMockRegistry([
      createState("shop", "connected", ["orders_list"]),
      createState("shop_orders", status, ["list"]),
      createState("time", "connected", ["current"]),
    ]);
    const aggregator = new ToolAggregator(registry);
    const resolver = new AggregatedToolResolver(aggregator, registry);
    assert.deepEqual(aggregator.listTools().map(tool => tool.name), ["time_current"]);
    assert.equal(await resolver.resolve("shop_orders_list"), null);
  }
});

test("normalizes punctuation and long names while retaining explicit native mappings", async () => {
  const longName = "very_long_".repeat(12);
  const registry = createMockRegistry([
    createState("my-shop", "connected", ["Orders.List", longName]),
  ]);
  const aggregator = new ToolAggregator(registry);
  const resolver = new AggregatedToolResolver(aggregator);
  const tools = aggregator.listTools();
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
    assert.equal((await resolver.resolve(tool.name))?.upstreamToolName, tool.upstreamToolName);
    assert.equal(tool.upstreamName, "my-shop");
  }
  assert.equal(aggregator.getTool("my_shop_orders_list")?.upstreamToolName, "Orders.List");
  assert.equal(await resolver.resolve("my-shop.Orders.List"), null);
  const longTool = tools.find(tool => tool.upstreamToolName === longName)!;
  assert.equal(longTool.name.length, 64);
  assert.equal(aggregator.getTool(longTool.name)?.name, longTool.name);
});

test("normalization collisions are omitted and recover after the conflict is disabled", () => {
  const conflict = createState("my_shop", "connected", ["list"]);
  const registry = createMockRegistry([
    createState("my-shop", "connected", ["list"]), conflict,
    createState("time", "connected", ["current"]),
  ]);
  const aggregator = new ToolAggregator(registry);
  assert.equal(aggregator.getTool("my_shop_list"), null);
  conflict.config.enabled = false;
  assert.equal(aggregator.getTool("my_shop_list")?.upstreamName, "my-shop");
});
