/**
 * Suite entry point.
 *
 * A single file that imports the rest, rather than a glob in an npm script:
 * `node --test <glob>` expands differently on cmd.exe, PowerShell and sh, and
 * this project has to run on all three.
 *
 * Docker-backed tests are behind `WT_TEST_DOCKER=1` - they take minutes, pull
 * images and publish real ports, which is not what `npm test` should do by
 * default. Everything else runs anywhere git does.
 */
import "./unit/naming.test.js";
import "./unit/manifest.test.js";
import "./unit/config.test.js";
import "./unit/hydrate.test.js";
import "./unit/state.test.js";
import "./unit/adapt.test.js";
import "./unit/render.test.js";
import "./unit/host-services.test.js";
import "./integration/lifecycle.test.js";
import "./integration/host-process.test.js";
import "./integration/stack.test.js";
