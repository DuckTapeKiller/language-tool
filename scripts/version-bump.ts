#!/usr/bin/env bun
import * as Bun from "bun";

const targetVersion = Bun.env.npm_package_version;

if (!targetVersion) throw new Error("npm_package_version environment variable not set");

// read minAppVersion from manifest.json and bump version to target version
const manifest = (await Bun.file("manifest.json").json()) as {
    version: string;
    minAppVersion: string;
    [key: string]: unknown;
};
const { minAppVersion } = manifest;
manifest.version = targetVersion;
await Bun.write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// update versions.json with target version and minAppVersion from manifest.json
const versions = (await Bun.file("versions.json").json()) as Record<string, string>;
versions[targetVersion] = minAppVersion;
await Bun.write("versions.json", JSON.stringify(versions, null, 2) + "\n");
