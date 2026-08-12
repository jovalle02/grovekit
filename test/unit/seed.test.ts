import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  credentialsFrom,
  engineFromImage,
  formatBytes,
  hasData,
  type DatabaseService,
} from "../../src/core/seed.js";

const db = (engine: DatabaseService["engine"]): DatabaseService => ({
  service: "db",
  engine,
  container: "slug-db-1",
  running: true,
  credentials: { user: "app", password: "app", database: "app" },
});

describe("engineFromImage", () => {
  it("recognises the engines whose dump tools ship inside the official image", () => {
    assert.equal(engineFromImage("postgres:16-alpine"), "postgres");
    assert.equal(engineFromImage("mysql:8"), "mysql");
    assert.equal(engineFromImage("mariadb:11"), "mysql");
    assert.equal(engineFromImage("mongo:7"), "mongo");
  });

  it("matches an image published under a registry and an organisation", () => {
    assert.equal(engineFromImage("ghcr.io/acme/postgres:16"), "postgres");
    assert.equal(engineFromImage("postgis/postgis:16-3.4"), "postgres");
    assert.equal(engineFromImage("timescale/timescaledb:latest-pg16"), "postgres");
  });

  it("returns null for anything it cannot copy, rather than guessing", () => {
    // Redis is a database and is deliberately not here: it has no dump tool on
    // this path, and offering a copy that then fails is worse than not offering.
    assert.equal(engineFromImage("redis:7-alpine"), null);
    assert.equal(engineFromImage("elasticsearch:8.13.0"), null);
    assert.equal(engineFromImage("node:22"), null);
  });
});

describe("credentialsFrom", () => {
  it("reads what the compose file already declares", () => {
    assert.deepEqual(
      credentialsFrom("postgres", { POSTGRES_USER: "app", POSTGRES_PASSWORD: "s3cret", POSTGRES_DB: "shop" }),
      { user: "app", password: "s3cret", database: "shop" },
    );
  });

  it("applies the image's own defaults when a variable is absent", () => {
    // The postgres image defaults the database to the user's name, so a compose
    // file that sets only POSTGRES_USER still has a database to dump.
    assert.deepEqual(credentialsFrom("postgres", { POSTGRES_USER: "app" }), {
      user: "app",
      password: "",
      database: "app",
    });
    assert.equal(credentialsFrom("postgres", {}).user, "postgres");
  });

  it("picks the mysql account that exists, not the one that might", () => {
    // MYSQL_USER present means that account was created with MYSQL_PASSWORD.
    assert.deepEqual(
      credentialsFrom("mysql", {
        MYSQL_USER: "app",
        MYSQL_PASSWORD: "app",
        MYSQL_ROOT_PASSWORD: "root",
        MYSQL_DATABASE: "shop",
      }),
      { user: "app", password: "app", database: "shop" },
    );

    // Absent, and root with MYSQL_ROOT_PASSWORD is the only way in.
    assert.deepEqual(
      credentialsFrom("mysql", { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "shop" }),
      { user: "root", password: "root", database: "shop" },
    );
  });
});

describe("hasData", () => {
  it("treats a freshly initialised database as empty", () => {
    // A new Postgres database is several megabytes of system catalogues. Copying
    // one buys nothing, so the offer has to be able to tell it apart from data.
    assert.equal(hasData(db("postgres"), { bytes: 7_800_000, rows: 0 }), false);
    assert.equal(hasData(db("postgres"), { bytes: 260_000_000, rows: 1_400_000 }), true);
  });

  it("decides on size, not on the row estimate", () => {
    // n_live_tup is maintained by the statistics collector and reads zero for
    // rows inserted since the last analyse. Deciding on it would refuse to copy
    // a database that was just filled, which is exactly when people want this.
    assert.equal(hasData(db("postgres"), { bytes: 400_000_000, rows: 0 }), true);
  });
});

describe("formatBytes", () => {
  it("reads the way a size is spoken, at every scale", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(260 * 1024 * 1024), "260 MB");
    assert.equal(formatBytes(3.5 * 1024 ** 3), "3.5 GB");
  });
});

