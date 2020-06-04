import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as cache from "@actions/cache";
import * as crypto from "crypto";
import * as fs from "fs";
import * as prettier from "prettier";
import { measure, isExactKeyMatch } from "./common";

async function run(): Promise<void> {
	try {
		let jekyllSrc = "",
			gemSrc = "",
			gemArr: string[],
			jekyllArr: string[],
			hash: string,
			exactKeyMatch: boolean,
			installFailure = false,
			restoreKeys: string[],
			key: string;
		const INPUT_JEKYLL_SRC = core.getInput("jekyll_src", {}),
			SRC = core.getInput("src", {}),
			INPUT_GEM_SRC = core.getInput("gem_src", {}),
			INPUT_ENABLE_CACHE = core.getInput("enable_cache", {}),
			INPUT_KEY = core.getInput("key", {}),
			INPUT_RESTORE_KEYS = core
				.getInput("restore-keys", {})
				.split("\n")
				.filter((x) => x !== "");
		const paths = ["vendor/bundle"];
		if (INPUT_RESTORE_KEYS) restoreKeys = INPUT_RESTORE_KEYS;
		else restoreKeys = ["Linux-gems-", "bundle-use-ruby-Linux-gems-"];

		await measure({
			name: "resolve directories",
			block: async () => {
				// Resolve Jekyll directory
				if (INPUT_JEKYLL_SRC) {
					jekyllSrc = INPUT_JEKYLL_SRC;
					core.debug(
						`Using parameter value ${jekyllSrc} as a source directory`
					);
				} else if (SRC) {
					jekyllSrc = SRC;
					core.debug(
						`Using ${jekyllSrc} environment var value as a source directory`
					);
				} else {
					jekyllArr = await (
						await glob.create(
							["**/_config.yml", "!**/vendor/bundle/**"].join("\n")
						)
					).glob();
					for (let i = 0; i < jekyllArr.length; i++) {
						jekyllArr[i] = jekyllArr[i].replace(/_config\.yml/, "");
					}
					if (jekyllArr.length > 1) {
						throw new Error(
							`error: found ${jekyllArr.length} _config.yml! Please define which to use with input variable "JEKYLL_SRC"`
						);
					} else {
						jekyllSrc = jekyllArr[0];
					}
				}
				core.debug(`Resolved ${jekyllSrc} as source directory`);

				// Resolve Gemfile directory
				if (INPUT_GEM_SRC) {
					gemSrc = INPUT_GEM_SRC;
					if (!gemSrc.endsWith("Gemfile")) {
						if (!gemSrc.endsWith("/")) {
							gemSrc = gemSrc.concat("/");
						}
						gemSrc = gemSrc.concat("Gemfile");
					}
				} else {
					gemArr = await (
						await glob.create(["**/Gemfile", "!**/vendor/bundle/**"].join("\n"))
					).glob();
					if (gemArr.length > 1) {
						if (!jekyllSrc.endsWith("/")) {
							jekyllSrc = jekyllSrc.concat("/");
						}
						if (jekyllSrc.startsWith(".")) {
							jekyllSrc = jekyllSrc.replace(
								/\.\/|\./,
								`${process.env.GITHUB_WORKSPACE}/`
							);
						} else if (!jekyllSrc.startsWith("/")) {
							jekyllSrc = `${process.env.GITHUB_WORKSPACE}/`.concat(jekyllSrc);
						}
						for (const element of gemArr) {
							if (element.replace(/Gemfile/, "") === jekyllSrc) {
								gemSrc = element;
							}
						}
						if (!gemSrc) {
							throw new Error(
								`found ${gemArr.length} Gemfiles, and failed to resolve them! Please define which to use with input variable "GEM_SRC"`
							);
						} else {
							core.warning(`found ${gemArr.length} Gemfiles!`);
						}
					} else {
						gemSrc = gemArr[0];
					}
				}
				core.debug(`Resolved ${gemSrc} as Gemfile`);
				core.exportVariable("BUNDLE_GEMFILE", `${gemSrc}`);
			},
		});

		if (INPUT_ENABLE_CACHE) {
			await measure({
				name: "restore bundler cache",
				block: async () => {
					if (!INPUT_KEY) {
						hash = crypto
							.createHash("sha256")
							.update(fs.readFileSync(`${gemSrc}.lock`))
							.digest("hex");
						core.debug(`Hash of Gemfile.lock: ${hash}`);
						key = `Linux-gems-${hash}`;
					} else key = INPUT_KEY;
					try {
						const cacheKey = await cache.restoreCache(paths, key, restoreKeys);
						if (!cacheKey) {
							core.info(
								`Cache not found for input keys: ${[key, ...restoreKeys].join(
									", "
								)}`
							);
							return;
						}
						exactKeyMatch = isExactKeyMatch(key, cacheKey);
					} catch (error) {
						if (error.name === cache.ValidationError.name) {
							throw error;
						} else {
							core.warning(error.message);
							exactKeyMatch = false;
						}
					}
					return;
				},
			});
		}

		await measure({
			name: "bundle install",
			block: async () => {
				await exec.exec("bundle config set deployment true");
				await exec.exec(
					`bundle config path ${process.env.GITHUB_WORKSPACE}/vendor/bundle`
				);
				try {
					await exec.exec(
						`bundle install --jobs=4 --retry=3 --gemfile=${gemSrc}`
					);
				} catch (error) {
					installFailure = true;
					core.error(
						'Gemfile.lock probably needs updating. Run "bundle install" locally and commit changes. Exiting action'
					);
					throw error;
				}
				return;
			},
		});

		if (!installFailure) {
			await measure({
				name: "jekyll build",
				block: async () => {
					core.exportVariable("JEKYLL_ENV", "production");
					return await exec.exec(`bundle exec jekyll build -s ${jekyllSrc}`);
				},
			});

			// maybe run this async with saving cache
			await measure({
				name: "format output html files",
				block: async () => {
					const formatFileArray = await (
						await glob.create(["_site/**/*.html"].join("\n"))
					).glob();
					for (const element of formatFileArray) {
						core.debug(element);
						fs.writeFileSync(
							element,
							prettier.format(fs.readFileSync(element, "utf8"), {
								useTabs: true,
								parser: "html",
							})
						);
					}
				},
			});

			if (INPUT_ENABLE_CACHE) {
				await measure({
					name: "save bundler cache",
					block: async () => {
						if (exactKeyMatch) {
							core.info(
								`Cache hit occurred on the primary key ${key}, not saving cache.`
							);
							return;
						}
						try {
							await cache.saveCache(paths, key);
						} catch (error) {
							if (error.name === cache.ValidationError.name) {
								throw error;
							} else if (error.name === cache.ReserveCacheError.name) {
								core.info(error.message);
							} else {
								core.warning(error.message);
							}
						}
						return;
					},
				});
			}
		}
	} catch (error) {
		core.setFailed(error.message);
	}
}
run();
