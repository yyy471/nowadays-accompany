"use strict";

const path = require("node:path");

const helpersDir = __dirname;
const testsDir = path.resolve(helpersDir, "..");
const desktopDir = path.resolve(testsDir, "..");
const appsDir = path.resolve(desktopDir, "..");
const repoRoot = path.resolve(appsDir, "..");
const backendDir = path.join(appsDir, "backend");
const rendererDir = path.join(desktopDir, "renderer");
const electronDir = path.join(desktopDir, "electron");
const xiachengPortraitFixture = path.join(rendererDir, "src", "assets", "themes", "xiacheng", "character.png");
const testResultsDir = path.join(repoRoot, "test-results");
const backendTestResultsDir = path.join(backendDir, "test-results");

module.exports = {
  repoRoot,
  appsDir,
  desktopDir,
  backendDir,
  rendererDir,
  electronDir,
  xiachengPortraitFixture,
  testResultsDir,
  backendTestResultsDir,
};
