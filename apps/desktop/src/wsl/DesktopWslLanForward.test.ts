import { assert, describe, it } from "@effect/vitest";
import type { DesktopServerExposureState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";

import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWslLanForward from "./DesktopWslLanForward.ts";
import { openWslLanForward } from "./DesktopWslLanForward.ts";
import { lanHostsFromExposure, planWslLanForward, wslTailscaleTarget } from "./wslLanForward.ts";

const exposure = {
  mode: "network-accessible" as const,
  advertisedHost: "192.168.1.50",
};

const endpoint = (href: string, executablePath = "wsl.exe") => ({
  executablePath,
  httpBaseUrl: new URL(href),
});

const boundPort = (server: NodeNet.Server) =>
  Effect.callback<number, Error>((resume) => {
    const fail = (error: Error) => resume(Effect.fail(error));
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      const address = server.address();
      resume(Effect.succeed(address && typeof address === "object" ? address.port : 0));
    });
  });

const closeServer = (server: NodeNet.Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

const exchange = (port: number, payload: Buffer) =>
  Effect.callback<Buffer, Error>((resume) => {
    const client = NodeNet.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const fail = (error: Error) => resume(Effect.fail(error));
    client.once("error", fail);
    client.on("data", (chunk) => {
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      if (received.length < payload.length) return;
      client.destroy();
      resume(Effect.succeed(received.subarray(0, payload.length)));
    });
    client.once("connect", () => client.write(payload));
    return Effect.sync(() => client.destroy());
  });

const quietProcess = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1),
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  stdin: Sink.drain,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
  unref: Effect.succeed(Effect.void),
});

const startConfig = (href: string, executablePath = "wsl.exe"): DesktopBackendStartConfig => ({
  executablePath,
  args: [],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: Number(new URL(href).port),
    host: "0.0.0.0",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  extendEnv: false,
  httpBaseUrl: new URL(href),
  captureOutput: false,
  preflightFailure: Option.none(),
});

describe("wslLanForward", () => {
  it("forwards a distro address when network access is on", () => {
    assert.deepEqual(
      planWslLanForward({ config: endpoint("http://172.27.0.99:5050/"), exposure }),
      {
        listenPort: 5050,
        targetHost: "172.27.0.99",
        targetPort: 5050,
        listenHosts: ["0.0.0.0", "192.168.1.50"],
      },
    );
    assert.deepEqual(wslTailscaleTarget(endpoint("http://172.27.0.99:5050/")), {
      localHost: "172.27.0.99",
      localPort: 5050,
    });
    assert.deepEqual(lanHostsFromExposure(exposure), ["192.168.1.50"]);
  });

  it("skips mirrored networking, local-only mode, and the Windows backend", () => {
    assert.isNull(planWslLanForward({ config: endpoint("http://127.0.0.1:5050/"), exposure }));
    assert.isNull(
      planWslLanForward({
        config: endpoint("http://172.27.0.99:5050/"),
        exposure: { mode: "local-only", advertisedHost: null },
      }),
    );
    assert.isNull(
      planWslLanForward({
        config: endpoint("http://172.27.0.99:5050/", process.execPath),
        exposure,
      }),
    );
    assert.isNull(wslTailscaleTarget(endpoint("http://172.27.0.99:5050/", process.execPath)));
    assert.deepEqual(lanHostsFromExposure({ mode: "local-only", advertisedHost: null }), []);
    assert.deepEqual(
      lanHostsFromExposure({ mode: "network-accessible", advertisedHost: null }),
      [],
    );
  });

  it.effect("relays bytes to the distro listener", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const echo = NodeNet.createServer((socket) => {
          socket.on("data", (chunk) => socket.write(chunk));
        });
        yield* Effect.addFinalizer(() => closeServer(echo));
        const echoPort = yield* boundPort(echo);
        const reserved = NodeNet.createServer();
        const forwardPort = yield* boundPort(reserved);
        yield* closeServer(reserved);

        const forward = yield* openWslLanForward({
          listenPort: forwardPort,
          listenHosts: ["127.0.0.1"],
          targetHost: "127.0.0.1",
          targetPort: echoPort,
        });
        if (forward === null) return yield* Effect.die("WSL forwarder did not listen");
        yield* Effect.addFinalizer(() => closeServer(forward));

        const received = yield* exchange(forwardPort, Buffer.from("ping"));
        assert.equal(Buffer.from(received).toString(), "ping");
      }),
    ),
  );

  it.effect("publishes the distro through the Windows tailscale command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* Ref.make<Array<readonly string[]>>([]);
        const reserved = NodeNet.createServer();
        const port = yield* boundPort(reserved);
        yield* closeServer(reserved);
        const spawner = ChildProcessSpawner.make((command) =>
          Ref.update(commands, (current) => [
            ...current,
            command._tag === "StandardCommand"
              ? [command.command, ...command.args.map(String)]
              : [],
          ]).pipe(Effect.as(quietProcess)),
        );
        const forward = yield* DesktopWslLanForward.DesktopWslLanForward.pipe(
          Effect.provide(
            DesktopWslLanForward.layer.pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
              Layer.provide(
                Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
                  getState: Effect.succeed({
                    mode: "network-accessible",
                    endpointUrl: `http://192.168.1.50:${port}`,
                    advertisedHost: "192.168.1.50",
                    tailscaleServeEnabled: true,
                    tailscaleServePort: 8443,
                  } satisfies DesktopServerExposureState),
                  backendConfig: Effect.die("unexpected backendConfig"),
                  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
                  setMode: () => Effect.die("unexpected setMode"),
                  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
                  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
                }),
              ),
            ),
          ),
        );
        const executable =
          (yield* HostProcess.Platform) === "win32" ? "tailscale.exe" : "tailscale";
        const target = `http://172.27.0.99:${port}`;

        yield* forward.primaryReady(startConfig(`http://127.0.0.1:${port}/`, process.execPath));
        assert.deepEqual(yield* Ref.get(commands), []);

        yield* forward.primaryReady(startConfig(`${target}/`));
        assert.deepEqual(yield* Ref.get(commands), [
          [executable, "status", "--json"],
          [executable, "serve", "--bg", "--https=8443", target],
        ]);

        yield* forward.primaryStopped;
        assert.deepEqual(yield* Ref.get(commands), [
          [executable, "status", "--json"],
          [executable, "serve", "--bg", "--https=8443", target],
          [executable, "serve", "--https=8443", "--set-path=/", "off"],
        ]);
      }),
    ),
  );
});
