import pkg from "../package.json" with { type: "json" };

// The app's version: package.json is the one place it is written, and each release is tagged v<version>.
export const VERSION: string = pkg.version;
