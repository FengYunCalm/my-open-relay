import { afterEach, describe, expect, it } from "vitest";

import { A2ARelayHost, resolveRelayPluginConfig } from "../support/relay-plugin-testkit.js";

const activeHosts: A2ARelayHost[] = [];

afterEach(async () => {
  await Promise.all(activeHosts.splice(0).map((host) => host.stop()));
});

describe("A2A relay host", () => {
  it("uses configured host, port, and base path", async () => {
    const config = resolveRelayPluginConfig({
      a2a: { host: "127.0.0.1", port: 0, basePath: "/relay", healthPath: "/healthz", readyPath: "/readyz" }
    });
    const host = new A2ARelayHost(config.a2a);
    activeHosts.push(host);

    const url = await host.start();

    expect(url).toContain("/relay");
    expect(host.port).toBeTypeOf("number");
  });

  it("starts exactly once when start is called repeatedly", async () => {
    const config = resolveRelayPluginConfig({ a2a: { port: 0 } });
    const host = new A2ARelayHost(config.a2a);
    activeHosts.push(host);

    const first = await host.start();
    const second = await host.start();

    expect(first).toBe(second);
    expect(host.isListening).toBe(true);
  });

  it("exposes health and readiness endpoints", async () => {
    const config = resolveRelayPluginConfig({ a2a: { port: 0 } });
    const host = new A2ARelayHost(config.a2a, {
      health: () => ({ service: "relay-plugin" }),
      readiness: () => ({ ok: false, detail: "warming-up" })
    });
    activeHosts.push(host);

    await host.start();

    const healthResponse = await fetch(`http://${config.a2a.host}:${host.port}${config.a2a.healthPath}`);
    const readyResponse = await fetch(`http://${config.a2a.host}:${host.port}${config.a2a.readyPath}`);
    const healthBody = await healthResponse.json();
    const readyBody = await readyResponse.json();

    expect(healthResponse.status).toBe(200);
    expect(healthBody.service).toBe("relay-plugin");
    expect(readyResponse.status).toBe(503);
    expect(readyBody.detail).toBe("warming-up");
  });

  it("supports explicit shutdown", async () => {
    const config = resolveRelayPluginConfig({ a2a: { port: 0 } });
    const host = new A2ARelayHost(config.a2a);

    activeHosts.push(host);
    await host.start();
    await host.stop();

    expect(host.isListening).toBe(false);
    expect(host.port).toBeUndefined();
  });
});
