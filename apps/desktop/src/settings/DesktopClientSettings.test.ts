import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

const clientSettings: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  notificationMode: "notifications-and-sound",
  inAppNotificationsEnabled: true,
  appearanceContrast: 100,
  browserDefaultViewport: { _tag: "preset", width: 1024, height: 600, presetId: "nest-hub" },
  browserDefaultZoomFactor: 1.25,
  browserDefaultAppearance: "dark",
  browserRecordingFrameRate: 60,
  browserLinkTarget: "app",
  browserAutoShowFloatingPreview: false,
  browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
  browserDefaultProfileId: "work",
  confirmQuit: "double-click",
  confirmThreadArchive: true,
  confirmThreadDelete: false,
  confirmThreadUnpin: false,
  contextWindowMeterEnabled: false,
  diffFilesCollapsed: true,
  diffIgnoreWhitespace: true,
  diffLayout: "stacked",
  environmentIdentificationMode: "artwork",
  favorites: [],
  fontFamilyCode: "",
  fontFamilyComposer: "",
  fontFamilySans: "",
  fontFamilyTerminal: "",
  fontSizeCode: 13,
  fontSizeInterface: 16,
  fontSizePrompt: 14,
  fontSizeTerminal: 12,
  fontSmoothing: true,
  glassOpacity: 80,
  onboardingCompletedAt: null,
  panelAnimationDurationMs: 0,
  planModeEnabled: false,
  proactivePanelsEnabled: true,
  showSkillsInSlashMenu: false,
  persistComposerContextStrip: true,
  providerModelPreferences: {},
  sidebarProjectGroupingMode: "repository_path",
  sidebarProjectGroupingOverrides: {
    "environment-1:/tmp/project-a": "separate",
  },
  sidebarProjectSortOrder: "manual",
  sidebarThreadSortOrder: "created_at",
  boringSidebarEnabled: false,
  boringSidebarMultilineRows: false,
  threadDetailsUsageEnabled: false,
  threadDetailsItems: {},
  legacySidebarEnabled: false,
  sidebarWorkingShelfEnabled: false,
  loadBalancingEnabled: false,
  loadBalancingWeights: { "environment-1": 75, "environment-2": 0 },
  pullRequestMergeMethodOverrides: {},
  timestampFormat: "24-hour",
  wordWrap: true,
};

const decodeClientSettingsJson = Schema.decodeEffect(Schema.fromJsonString(ClientSettingsSchema));
function layer(baseDir: string) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  return DesktopClientSettings.layer.pipe(
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withClientSettings = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopClientSettings.DesktopClientSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-client-settings-test-",
    });
    return yield* effect.pipe(Effect.provide(layer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopClientSettings", () => {
  it.effect(
    "publishes committed preferences only after rename and serializes concurrent writers",
    () =>
      withClientSettings(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const published: ClientSettings[] = [];
          let renames = 0;
          const files = new Map<string, string>();
          const settings = yield* DesktopClientSettings.make.pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.FileSystem.of({
                ...fs,
                readLink: (path) =>
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "readLink",
                      pathOrDescriptor: path,
                    }),
                  ),
                makeDirectory: () => Effect.void,
                writeFileString: (path, value) =>
                  Effect.sync(() => {
                    files.set(path, value);
                  }),
                rename: (from, to) =>
                  Effect.gen(function* () {
                    renames++;
                    if (renames === 1) {
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(resume);
                    }
                    const contents = files.get(from);
                    if (contents === undefined) return yield* Effect.die("missing temporary file");
                    files.set(to, contents);
                    files.delete(from);
                  }),
              }),
            ),
          );
          yield* settings.onCommitted((value) => published.push(value));
          const first = yield* settings.set(clientSettings).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const secondValue = { ...clientSettings, desktopSystemMaterialEnabled: true };
          const secondStarted = yield* Deferred.make<void>();
          const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
            Effect.andThen(settings.set(secondValue)),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(secondStarted);
          const renamesBeforeRelease = renames;
          const publishedBeforeRelease = [...published];
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          assert.equal(renamesBeforeRelease, 1);
          assert.deepEqual(publishedBeforeRelease, []);
          assert.deepEqual(published, [clientSettings, secondValue]);
          assert.deepEqual(
            yield* decodeClientSettingsJson(files.get(environment.clientSettingsPath) ?? ""),
            secondValue,
          );
        }),
      ),
  );

  it.effect("failed replacement publishes nothing and releases the writer permit", () =>
    withClientSettings(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let fail = true;
        const settings = yield* DesktopClientSettings.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fs,
              rename: (from, to) =>
                fail
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                      }),
                    )
                  : fs.rename(from, to),
            }),
          ),
        );
        const published: ClientSettings[] = [];
        yield* settings.onCommitted((value) => published.push(value));
        const error = yield* settings.set(clientSettings).pipe(Effect.flip);
        assert.equal(error.operation, "replace-settings-file");
        assert.deepEqual(published, []);
        fail = false;
        yield* settings.set(clientSettings);
        assert.deepEqual(published, [clientSettings]);
      }),
    ),
  );

  it.effect("saves through a symlinked client settings file without replacing the link", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-client-settings-dotfiles-",
        });
        const linkedSettingsPath = `${dotfiles}/client-settings.json`;
        yield* fileSystem.writeFileString(linkedSettingsPath, "{}\n");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.symlink(linkedSettingsPath, environment.clientSettingsPath);

        yield* settings.set(clientSettings);

        assert.equal(
          yield* fileSystem.readLink(environment.clientSettingsPath),
          linkedSettingsPath,
        );
        assert.deepEqual(
          yield* decodeClientSettingsJson(yield* fileSystem.readFileString(linkedSettingsPath)),
          clientSettings,
        );
      }),
    ),
  );

  it.effect.each([
    { label: "permission", reason: "PermissionDenied" },
    { label: "I/O", reason: "Unknown" },
  ] as const)("preserves saved preferences across $label read failures and retries", (failure) =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        const savedSettings = {
          ...clientSettings,
          onboardingCompletedAt: "2026-09-05T12:00:00.000Z",
        };
        yield* settings.set(savedSettings);
        const savedContents = yield* fileSystem.readFileString(environment.clientSettingsPath);
        const cause = PlatformError.systemError({
          _tag: failure.reason,
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: environment.clientSettingsPath,
        });
        let failRead = true;
        const retryableSettings = yield* DesktopClientSettings.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fileSystem,
              readFileString: (path) =>
                Effect.suspend(() =>
                  failRead ? Effect.fail(cause) : fileSystem.readFileString(path),
                ),
            }),
          ),
        );

        const error = yield* retryableSettings.get.pipe(Effect.flip);
        assert.instanceOf(error, DesktopClientSettings.DesktopClientSettingsReadError);
        assert.equal(error.operation, "read-file");
        assert.equal(error.path, environment.clientSettingsPath);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          yield* fileSystem.readFileString(environment.clientSettingsPath),
          savedContents,
        );

        failRead = false;
        assert.deepEqual(yield* retryableSettings.get, Option.some(savedSettings));
      }),
    ),
  );

  it.effect("loads lenient direct client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            // Matches server settings parsing.
            "timestampFormat": "24-hour",
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "24-hour");
        }
      }),
    ),
  );

  it.effect("loads legacy wrapped client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            "settings": {
              "timestampFormat": "12-hour"
            }
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "12-hour");
        }
      }),
    ),
  );

  it.effect.each([
    { label: "malformed JSON", contents: "{not-json" },
    { label: "invalid legacy settings", contents: '{"settings":{"fontSizeCode":"large"}}' },
  ])("reports $label without treating the settings file as absent", (document) =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, document.contents);

        const error = yield* settings.get.pipe(Effect.flip);
        assert.instanceOf(error, DesktopClientSettings.DesktopClientSettingsReadError);
        assert.equal(error.operation, "decode-document");
        assert.equal(error.path, environment.clientSettingsPath);
        assert.instanceOf(error.cause, Schema.SchemaError);
        assert.equal(
          yield* fileSystem.readFileString(environment.clientSettingsPath),
          document.contents,
        );
      }),
    ),
  );
});
