import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  executeTool,
  type ExecutionDependencies,
} from "./execute-tool.js";

import type {
  AuditRecord,
} from "../audit/logger.js";

test("executes an authorized calculator tool", async () => {
  const records: AuditRecord[] = [];

  const dependencies: ExecutionDependencies = {
    resolver: {
      async resolve(publicToolName) {
        if (publicToolName !== "calculator_calculate") {
          return null;
        }

        return {
          publicName: "calculator_calculate",
          upstreamName: "calculator",
          upstreamToolName: "calculate",
        };
      },
    },

    invoker: {
      async invoke(_tool, args) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                result:
                  Number(args.a) + Number(args.b),
              }),
            },
          ],
        };
      },
    },

    auditLogger: {
      async write(record) {
        records.push(record);
      },
    },
  };

  const response = await executeTool(
    {
      identity: {
        userId: "user-1",
        role: "member",
        keyId: "key-1",
      },

      toolName: "calculator_calculate",

      arguments: {
        operation: "add",
        a: 10,
        b: 20,
      },

      requestId: randomUUID(),
    },
    dependencies,
  );

  assert.equal(response.result.isError, undefined);

  assert.equal(records.length, 1);

  assert.equal(records[0].outcome, "success");

  assert.equal(
    records[0].toolName,
    "calculator_calculate",
  );

  assert.equal(
    records[0].upstreamName,
    "calculator",
  );
});

test("rejects unauthorized member tool calls", async () => {
  const records: AuditRecord[] = [];

  let invoked = false;

  const dependencies: ExecutionDependencies = {
    resolver: {
      async resolve() {
        return {
          publicName: "woocommerce_create_product",
          upstreamName: "woocommerce",
          upstreamToolName: "create_product",
        };
      },
    },

    invoker: {
      async invoke() {
        invoked = true;

        return {
          content: [],
        };
      },
    },

    auditLogger: {
      async write(record) {
        records.push(record);
      },
    },
  };

  await assert.rejects(
    executeTool(
      {
        identity: {
          userId: "user-2",
          role: "member",
          keyId: "key-2",
        },

        toolName: "woocommerce_create_product",

        arguments: {
          name: "Test Product",
          regular_price: "100",
        },

        requestId: randomUUID(),
      },
      dependencies,
    ),
    {
      name: "AuthorizationError",
    },
  );

  assert.equal(invoked, false);

  assert.equal(records.length, 1);

  assert.equal(records[0].outcome, "unauthorized");
});