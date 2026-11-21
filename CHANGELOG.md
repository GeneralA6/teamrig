# Changelog

## [0.500.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.499.0...teamrig-v0.500.0) (2026-11-21)


### Features

* **ci:** count each skill's host and tool words against a baseline that may fall, never rise (T4860) ([a9ea3e5](https://github.com/teamrig/teamrig/commit/a9ea3e590a1acb6d04dbe883d0d4106622de3fc0))
* **cli:** a run asks its host who it is (T4749) ([25e24ae](https://github.com/teamrig/teamrig/commit/25e24ae8a3932396d12ef4594bc6d9c730f524e8))
* **composition:** the run is given every shipped host adapter (T4749) ([5608e5e](https://github.com/teamrig/teamrig/commit/5608e5e9886f0f3e37c1f8d1964d3a16bd97e7af))
* **conformance:** a plugin contract, bound to the Claude Code adapter (T4750) ([fc7d08c](https://github.com/teamrig/teamrig/commit/fc7d08c682f13dfa34370724f8ea8f6bf75376fb)), closes [#1988](https://github.com/teamrig/teamrig/issues/1988)
* **core:** the program runner can cap what one run prints (T4767) ([d63c9f0](https://github.com/teamrig/teamrig/commit/d63c9f084ea4efb8530ac1856dc6b9c9d1195bb9))
* **host:** a plugin port: the plugin list, the marketplace list, the cache and the update steps (T4750) ([31ea5fc](https://github.com/teamrig/teamrig/commit/31ea5fc8120af51a286f283b30864216e70979aa)), closes [#1988](https://github.com/teamrig/teamrig/issues/1988)
* **ports:** the host's paths tell its own secret files (T4749) ([4255113](https://github.com/teamrig/teamrig/commit/4255113947854ba65f34f084f4f3ca794010ebdc))
* **ports:** the host's session launcher port, telling who a run is (T4749) ([e8b2653](https://github.com/teamrig/teamrig/commit/e8b2653a6ed8fdc5bf8957a33b8b9039fcc29c87))
* **queue:** a waiting ship moves its clean tool checkout to the newest main instead of refusing (T4280) ([2b5edda](https://github.com/teamrig/teamrig/commit/2b5eddae0c875360c49da79388e3922248b56376))


### Bug Fixes

* **budget:** the pace line after a reset inside the week starts at the use the reset left (T4864) ([3a4065c](https://github.com/teamrig/teamrig/commit/3a4065cd2b5801151065c9a09c7b5b8bbb444203))
* **secret-guard:** the guard keeps Claude Code's login and prompt history in a moved folder too (T4749) ([5334e33](https://github.com/teamrig/teamrig/commit/5334e33b71932c3964fd861bfd79500650844438))
* **secret-guard:** the guard keeps Claude Code's login in a folder named like its own too (T4749) ([3b3d2cb](https://github.com/teamrig/teamrig/commit/3b3d2cbcc9992973c7fb27b0c538e27b15de8458))
* **ship:** a main move read right after older merges landed in the landing turn is not counted toward the merge's three (T4280) ([bb6648c](https://github.com/teamrig/teamrig/commit/bb6648c260dd337fde2bbe559a5fe2c8c173a96f))

## [0.499.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.498.0...teamrig-v0.499.0) (2026-11-21)


### Features

* **conformance:** a permissions contract, bound to the Claude Code adapter (T4750) ([ba376c1](https://github.com/teamrig/teamrig/commit/ba376c1ad836f16a1652a6e7cb490653ebe8a2ec)), closes [#1988](https://github.com/teamrig/teamrig/issues/1988)
* **delivery:** read the tree a host step runs on, and keep it on its ledger record ([#708](https://github.com/teamrig/teamrig/issues/708)) ([04b9c3a](https://github.com/teamrig/teamrig/commit/04b9c3a5e28ea10d9147d62e9217eff956dfaa76))
* **host:** a permissions port: allow and deny rules, the credential deny lines and the trusted routes (T4750) ([8dc641b](https://github.com/teamrig/teamrig/commit/8dc641b7619538b7a2055f075285385b30f01245)), closes [#1988](https://github.com/teamrig/teamrig/issues/1988)
* **interface:** the served interface is 1.4, the minor that adds the stats document ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([e578287](https://github.com/teamrig/teamrig/commit/e578287f9144764565c1a37a4b93ff103c20cdc9))
* **interface:** the stats body serves the register's numbers over a range, the tasks behind each count by id ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([ca0739f](https://github.com/teamrig/teamrig/commit/ca0739f55c7e5ac3f25410918e568ab74143f8b7))
* **ports:** the host's paths tell its context files (T4749) ([33c40a7](https://github.com/teamrig/teamrig/commit/33c40a728c0a6cb9234de2209ea3b2c3b1296363))
* **queue:** record the tree a step runs on, and start a detached run's log with it ([#708](https://github.com/teamrig/teamrig/issues/708)) ([8c9b108](https://github.com/teamrig/teamrig/commit/8c9b108e776f262cd3d1a8d0cd0d188e14c3402d))
* **read:** teamrig read stats serves the register's numbers over --range, with validUntil for the counts the clock ages ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([1cd81ac](https://github.com/teamrig/teamrig/commit/1cd81ac3e4887d1f02f6646b7d7d27ed79a288c7))
* **register:** the end of a calendar day in the team's zone is exported for the stats document ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([ece7123](https://github.com/teamrig/teamrig/commit/ece7123a39e7117a5d4c708eac2a9dabe75caf99))
* **test:** a teamrig test log starts with the folder and tree it ran on ([#708](https://github.com/teamrig/teamrig/issues/708)) ([fc3a450](https://github.com/teamrig/teamrig/commit/fc3a450abbf3b8047a8699cdeb5347f6070a0968))


### Bug Fixes

* **cli:** open's help says it takes no --session and names --terminal print ([029c5bd](https://github.com/teamrig/teamrig/commit/029c5bd51ee22c6717c560eb271be76d577f39a3)), closes [#1307](https://github.com/teamrig/teamrig/issues/1307)
* **delivery:** the tree header names a Windows top level with backslashes, like the folder line ([#708](https://github.com/teamrig/teamrig/issues/708)) ([d169e83](https://github.com/teamrig/teamrig/commit/d169e8368952d10e762e4672ac37e0b894ea5704))
* **rename:** point another session's rename at inbox status, never a read ([#1255](https://github.com/teamrig/teamrig/issues/1255)) ([e76b04a](https://github.com/teamrig/teamrig/commit/e76b04a4b2b8791968014cdd5855f49aac3d07d9))
* **rename:** print the follow-up steps for the renamed session ([#1255](https://github.com/teamrig/teamrig/issues/1255)) ([77da92c](https://github.com/teamrig/teamrig/commit/77da92c840951d1a80516a36f4e38166766f7e33))

## [0.498.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.497.0...teamrig-v0.498.0) (2026-11-21)


### Features

* **adapters:** the Claude Code adapter fills the hook bridge and the tool-call shape (T4749) ([ebc5609](https://github.com/teamrig/teamrig/commit/ebc5609963e6e257ed0890f756de8c2c751be5ed))
* **cli:** a hook command reads its input and words its reply through the host's bridge (T4749) ([18294ff](https://github.com/teamrig/teamrig/commit/18294fff1ad374cc0962af35557c21c76119f413))
* **cli:** a run asks its host for its paths and its own folder (T4749) ([16f7b0c](https://github.com/teamrig/teamrig/commit/16f7b0c15885690f52122d0912e8c0c2e726cbad))
* **cli:** teamrig ui starts the dedicated UI in the terminal it is run in (T4761) ([3302d9e](https://github.com/teamrig/teamrig/commit/3302d9edeb4f81dfdf2b06bae5f4ae15682c5108))
* **composition:** the host source refuses an adapter that leaves a port unnamed (T4749) ([a60943e](https://github.com/teamrig/teamrig/commit/a60943ebf25f92746fa178e79928a13c3cc406b5))
* **config:** namedOnly gives a setting's value less every key its schema does not name (T4741) ([bf71003](https://github.com/teamrig/teamrig/commit/bf7100312363f35d85058be51660fd2ace209b94))
* **config:** the schema marks how teamrig read serves a key that may name a secret (T4741) ([d235839](https://github.com/teamrig/teamrig/commit/d2358393d39d20369b0a639257c210001eed6113))
* **config:** ui.path names a UI entry script to start in place of the released UI (T4761) ([2c1872f](https://github.com/teamrig/teamrig/commit/2c1872f34a970c0bc27836ac69a4e124b782c097))
* **hooks:** refusal and heldBack give a guard's answer as a reply (T4749) ([b83d88b](https://github.com/teamrig/teamrig/commit/b83d88b23ae15725b6d26c093e716a41e4da5351))
* **host:** a hook event says why its session ended (T4749) ([472c96d](https://github.com/teamrig/teamrig/commit/472c96d8d6fcdb50670a3111b18bae286e963089))
* **host:** a tool call that stops the turn to ask says what it asks, and its first question (T4749) ([2d54db4](https://github.com/teamrig/teamrig/commit/2d54db448a9438cfb5cff698c8acdac810cea5ce))
* **host:** the hook event names the session's title and the turn's effort (T4749) ([657af2a](https://github.com/teamrig/teamrig/commit/657af2a914d160ae6160ba94cfae4e5a612db688))
* **interface:** a document's revision as one text of what decides its answer (T4741) ([79da9d3](https://github.com/teamrig/teamrig/commit/79da9d3658ef86f486d072bd3400a39b1c7f1f84))
* **interface:** a task's ref and source as data, through a connector port GitHub is the first to fill (T4741) ([280a9c3](https://github.com/teamrig/teamrig/commit/280a9c393b1e13e8502342c4c4cb1820d5e5c8dd))
* **interface:** goalsBody, the goals a team's tasks may serve as data (T4829) ([f02dde9](https://github.com/teamrig/teamrig/commit/f02dde9f7b6e0ecb4e53d021e82797626034d00c))
* **interface:** historyBody serves one task's events, each text marked and cut ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([d92c378](https://github.com/teamrig/teamrig/commit/d92c378bfc475b6d9b7b0043cb883f3d77b78561))
* **interface:** sessions serves a team's own words only to itself and the teams below it (T4741) ([ea191ad](https://github.com/teamrig/teamrig/commit/ea191addf4fec0be44bdbb9a10bd72ccf7b2c8ad))
* **interface:** the config document, every setting row with its value scanned text by text (T4741) ([a7fc489](https://github.com/teamrig/teamrig/commit/a7fc48923a040e612ba126681bdddd0ac1191968))
* **interface:** the plan document's builder, a team's active tasks as its plan places them (T4829) ([14d3d10](https://github.com/teamrig/teamrig/commit/14d3d10153f98057c7c0f05623381ed3edc56b56))
* **interface:** the plan names who else needs each task and each finished task's work class (T4829) ([fabe9cc](https://github.com/teamrig/teamrig/commit/fabe9cc673b0847bf3a7ff10e4aefb3fcdd2c6fe))
* **interface:** the public interface's version, envelope and text rules (T4741) ([5c8246d](https://github.com/teamrig/teamrig/commit/5c8246d2b6f662d615f70bdc294aadde73b05859))
* **interface:** the served interface is 1.1, the minor that adds the plan document (T4829) ([9e9cfc8](https://github.com/teamrig/teamrig/commit/9e9cfc81142e762769bd267f70fb0548e90c9960))
* **interface:** the served interface is 1.2, the minor that adds the goals document ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([f3c2d97](https://github.com/teamrig/teamrig/commit/f3c2d971fa9fc1e352407e8bdb24e8c36012ef02))
* **interface:** the served interface is 1.3, the minor that adds the history document ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([fc36b9f](https://github.com/teamrig/teamrig/commit/fc36b9f99d27ca332885410f9fe836fff7bc8f0f))
* **interface:** the sessions document, every session of the tree with its place, hire, state and unread count (T4741) ([6749391](https://github.com/teamrig/teamrig/commit/674939194dbb2d29a12396de4896c0e9f2f6b2d8))
* **interface:** the tasks document, each served field named one by one (T4741) ([18f74c0](https://github.com/teamrig/teamrig/commit/18f74c0fa4f17dd5dfc84abd515e1dc8e0b292b8))
* **ports:** the host ports HookBridge and ToolCallShape, named by every host adapter (T4749) ([06f53eb](https://github.com/teamrig/teamrig/commit/06f53eb1b40170b5ba4a66757bd20cd1addfa061))
* **ports:** the host's paths port, its own folder and its temporary one (T4749) ([af012ac](https://github.com/teamrig/teamrig/commit/af012ac49db5c972a6c91249988d431162dfe6ca))
* **ports:** the host's paths tell its memory folders, scratchpads, plan files and shell snapshots (T4749) ([977a89f](https://github.com/teamrig/teamrig/commit/977a89f924d02222a7b3be58ecd71ab914291336))
* **ports:** the host's paths tell its settings files and its worktrees (T4749) ([144c267](https://github.com/teamrig/teamrig/commit/144c2675f575f5c69722a7ceaf54270ee7b808aa))
* **ports:** the host's paths tell the folder it loads a person's skills from (T4749) ([c360029](https://github.com/teamrig/teamrig/commit/c360029840ea89c3e4d2ef0b1a3d1ad7c3030acd))
* **read:** read --unless answers a document the reader holds as unchanged, with no fold (T4741) ([4124962](https://github.com/teamrig/teamrig/commit/412496260f017b6d5d21522b1d452b1d0dcf588c))
* **read:** read serves the config document, and answers it to a run with no team (T4741) ([a1e1cda](https://github.com/teamrig/teamrig/commit/a1e1cdaf1e49dafd59ffa9e93edbab5bf4f31555))
* **read:** read serves the meetings document (T4741) ([907c1be](https://github.com/teamrig/teamrig/commit/907c1beed7a1a97ee072a7bfbbc1edef2035cbc2))
* **read:** teamrig read, the public interface's read side, serving tasks (T4741) ([281cf29](https://github.com/teamrig/teamrig/commit/281cf2903fb23d86512f3d3cb1b6542d00feef5a))
* **read:** the goals document, a team's goals and those of the teams above it (T4829) ([e62d39a](https://github.com/teamrig/teamrig/commit/e62d39a6b3a7c335f8f7aace80c8d7ee3076d38a))
* **read:** the history document serves one task's events, named with --task ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([a8c97a2](https://github.com/teamrig/teamrig/commit/a8c97a2db577ce50ec7f6c831b66d923ba8a2fcf))
* **read:** the inbox document, a session's own lines with none marked read (T4741) ([486c5dc](https://github.com/teamrig/teamrig/commit/486c5dc2181e9d43d11844103f314d1105701872))
* **read:** the plan document, a team's tasks as teamrig's own tree places them (T4829) ([fc7f239](https://github.com/teamrig/teamrig/commit/fc7f2397704c6c38074c4c14c30e3bc2198d82ce))
* **read:** the sessions document and --conversation, the caller's own session by its conversation (T4741) ([1755854](https://github.com/teamrig/teamrig/commit/1755854721d270cbb3979311e5bf4ab74e03d303))
* **secrets:** a Discord webhook URL is a secret shape (T4741) ([330b68d](https://github.com/teamrig/teamrig/commit/330b68d294b530a87886bcf36bdda2bd8a9bee55))
* **secrets:** an npm token and a Slack webhook URL are secret shapes (T4741) ([1c53325](https://github.com/teamrig/teamrig/commit/1c53325b1ad994507d982295964618ab5c628806))
* **ship:** a merge's pull request takes its task's issue title, Closes line and labels, and opens none for a task with no issue (T4796) ([804cee6](https://github.com/teamrig/teamrig/commit/804cee6ce815767c4bba46c40c74a8e71e48f7c0))
* **ship:** dress a ship's pull request from its task: issue title, Closes line, the repo's labels (T4796) ([258feda](https://github.com/teamrig/teamrig/commit/258feda3e11b29aec835404fcf5e554ecd23adaa))
* **ship:** ship.ts pr titles, closes and labels the pull request from its task, and opens none for a task with no issue (T4796) ([137605f](https://github.com/teamrig/teamrig/commit/137605f7fadec8d9dbb242c334a9ed6923f8f585))
* **ui:** a pinned UI release is fetched once, held to its sha256 and found installed after (T4761) ([0fd1114](https://github.com/teamrig/teamrig/commit/0fd1114becdf4710040f9ca8a693772adf57dfa2))
* **ui:** a read UI archive is written under the kit home and counts as installed by its mark (T4761) ([f23fd22](https://github.com/teamrig/teamrig/commit/f23fd222688ee80a3dc590180b7a2cdec5e1f2c5))
* **ui:** a released UI gets only the caller's paths, terminal, locale and teamrig variables (T4761) ([2c0de03](https://github.com/teamrig/teamrig/commit/2c0de03873fb10b6c9eeead7b85a3485712f6340))
* **ui:** teamrig ui starts the pinned released UI when ui.path is unset (T4761) ([fb06537](https://github.com/teamrig/teamrig/commit/fb0653742cd74c63536588301670d7ec4855a0d1))
* **ui:** the fetch of the dedicated UI's archive follows a few https redirects itself (T4761) ([1a8ac62](https://github.com/teamrig/teamrig/commit/1a8ac626f255703c4e78ce640b8ec4cecc7b35a5))
* **ui:** the reader of the dedicated UI's archive holds its bytes to a pinned sha256 (T4761) ([943bfb0](https://github.com/teamrig/teamrig/commit/943bfb01b09e9b5f847c34656cab5125fda91cc7))
* **ui:** the released UI's pin is a constant of teamrig's source, never a config key (T4761) ([3208f11](https://github.com/teamrig/teamrig/commit/3208f11470d944f962bf04d8bbf62744eb5539a6)), closes [#1980](https://github.com/teamrig/teamrig/issues/1980)


### Bug Fixes

* **cli:** teamrig ui is a write, so /teamrig runs it only when the person types it (T4761) ([b34a7f7](https://github.com/teamrig/teamrig/commit/b34a7f7396754ddfd2098f9d9ab7f23774f2047b))
* **config:** ui is an owner-gated key, as teamrig ui runs the script ui.path names (T4761) ([ddd3b93](https://github.com/teamrig/teamrig/commit/ddd3b9313348169223a84a0c023e93050af30b55))
* **github:** a closed issue's evidence is the page teamrig builds, never the address the API sent ([#1982](https://github.com/teamrig/teamrig/issues/1982)) ([9aee640](https://github.com/teamrig/teamrig/commit/9aee6402a478df5de9bb5eee8075cb7d998cf5d6))
* **goals:** a goal record's time is held to the stamp teamrig writes ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([4daa238](https://github.com/teamrig/teamrig/commit/4daa2389e6dce5a9f81af13e84355743455c3312))
* **interface:** a cut inbox line is keyed by its place in the file, not by a fingerprint of its words (T4741) ([bae4cfc](https://github.com/teamrig/teamrig/commit/bae4cfc80d8c41d52079d36c3cc0e93d6ac4cb2e))
* **interface:** a read's problems name a file from its team's folder down and never quote a parser (T4741) ([77146c8](https://github.com/teamrig/teamrig/commit/77146c819daac3440754ea6b25b8799d80e73202))
* **interface:** a ref's url is served only as an https address (T4741) ([39c8312](https://github.com/teamrig/teamrig/commit/39c831235fe6293a80237880e4708fff9ac2f554))
* **interface:** a task's source name and the inbox's session name pass the secret scan (T4741) ([fda4ea7](https://github.com/teamrig/teamrig/commit/fda4ea7915a083051fb842b6eb1fce7e926a93ac))
* **interface:** read holds --team and --owner to an id's shape and serves inbox only to a session the team has (T4741) ([6089986](https://github.com/teamrig/teamrig/commit/608998681d9c86aa64114105ce1977d85a700fa1))
* **read:** a goal slip's time is served as the instant it reads as ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([a464a38](https://github.com/teamrig/teamrig/commit/a464a38d992c99db12f364a8965704649ed76141))
* **read:** a team whose config names no lead serves no leader, never an empty id ([#1982](https://github.com/teamrig/teamrig/issues/1982)) ([820c442](https://github.com/teamrig/teamrig/commit/820c442646d74f10505b0308399c3601d2237282))
* **read:** a week's rate that cannot be read fails the plan's revision as it fails the plan (T4829) ([c6efb71](https://github.com/teamrig/teamrig/commit/c6efb7194ae7d61210eed1bb915a64de9fb41c6b))
* **read:** the plan serves a wait's stored time that reads as none as null ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([5e975c4](https://github.com/teamrig/teamrig/commit/5e975c42bd9266c822bb74b34dccdea627718572))
* **register:** an event's time is held to the stamp the register writes ([#2058](https://github.com/teamrig/teamrig/issues/2058)) ([5afe6fa](https://github.com/teamrig/teamrig/commit/5afe6fa044c554eb5b6106e3dea778b2f29c4e4a))
* **ship:** a note that is Part of or Refs the task's issue gets no Closes line, so a slice's merge leaves it open (T4796) ([c6e4f24](https://github.com/teamrig/teamrig/commit/c6e4f2401e34e142bf3bb7b07729fc7f5014a84f))
* **ui:** a released UI gets only the TEAMRIG_ variables the CLI reads, not every TEAMRIG_ name (T4851) ([1ddece1](https://github.com/teamrig/teamrig/commit/1ddece10da49e0a917213edf4cbefec65399585c))
* **ui:** a released UI installs whole into a folder of its pin, and each start holds every file to it (T4761) ([81a9952](https://github.com/teamrig/teamrig/commit/81a9952eeb623a10364e4fa705942b210f9789c0)), closes [#1980](https://github.com/teamrig/teamrig/issues/1980)

## [0.497.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.496.0...teamrig-v0.497.0) (2026-11-21)


### Features

* **adapters:** Claude Code, GitHub and local say what they support (T4618) ([457cc14](https://github.com/teamrig/teamrig/commit/457cc14fd310fa16a7f0bd6757913010ce36cfb0))
* **adapters:** the six built-in terminals declare what each can do ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([98780bc](https://github.com/teamrig/teamrig/commit/98780bc3840f6c2988b7e8e13c42ebb2d6f8e37b))
* **ci:** a boundary check counts what crosses the layers of src, in warn mode (T4618) ([445c3bb](https://github.com/teamrig/teamrig/commit/445c3bbd044b28de11ca34ff5ab61acb28646070))
* **cli:** issue reply refuses an issue two active tasks share, naming them (T3169) ([8f948a8](https://github.com/teamrig/teamrig/commit/8f948a86136dba81149d0bde6c5e16d1bd73d5cd))
* **cli:** issue reply takes the thread's state with its words, replacing issue comment (T3169) ([32f01f6](https://github.com/teamrig/teamrig/commit/32f01f665ee62fdc9b892de0e0f6d9fc484894fe))
* **composition:** the loader reads the six terminal adapters, and the parity page draws them ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([47b9804](https://github.com/teamrig/teamrig/commit/47b98044705ec1a11a7ddc103b4101e315025c2a))
* **composition:** the loader takes an adapter by its id, and toggles resolve on its manifest (T4618) ([e2ec3db](https://github.com/teamrig/teamrig/commit/e2ec3dbe7074daa4d2dd7e481ab4b84b3e7de8ad))
* **config:** version 9 takes issue comment off each service role, a role left with none dropped (T3169) ([08859bd](https://github.com/teamrig/teamrig/commit/08859bd375dc56ce8980198f5f3941c3f5f02434))
* **conformance:** a port's contract is a value an adapter binds, and its cases run to results ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([dbbce9f](https://github.com/teamrig/teamrig/commit/dbbce9f6825f40c3d9c19e06275bb1250e24c2e5))
* **conformance:** an adapter's manifest picks the cases that run for it ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([878b3b4](https://github.com/teamrig/teamrig/commit/878b3b47e5e7c5c59d49f973beadf190cb528b39))
* **conformance:** the kit lists its contracts and fails one a liar passes ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([e8d3608](https://github.com/teamrig/teamrig/commit/e8d3608e6dd3c6a51703848aed76a011edf2390b))
* **conformance:** the terminal contract, with a reference terminal and two liars ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([e3e8230](https://github.com/teamrig/teamrig/commit/e3e8230c89528be67885876f238c997bd33fa09c))
* **connectors:** the GitHub adapter builds its tracker and code host ([#1885](https://github.com/teamrig/teamrig/issues/1885)) ([ec072f5](https://github.com/teamrig/teamrig/commit/ec072f5acf24989a27ebfab2920292807d11bf7c))
* **core:** a program run takes the environment its caller sets ([#1885](https://github.com/teamrig/teamrig/issues/1885)) ([b9551e6](https://github.com/teamrig/teamrig/commit/b9551e64325f76bccb19b66d8c33cd5628a61bc8))
* **core:** a reader for the stored host session field, under its new name or a store's old one (T4762) ([e751f16](https://github.com/teamrig/teamrig/commit/e751f16a3a14edd92ce1f3a151735a9eaf93b751))
* **core:** an HTTP client port for connectors: https only, no redirect followed, a time and a length limit (T4754) ([207e28e](https://github.com/teamrig/teamrig/commit/207e28e5299caea86cff836d80196134fe84b763))
* **core:** the stamp's name, link and version as parts, for a tool whose text is not Markdown (T4754) ([fdaf955](https://github.com/teamrig/teamrig/commit/fdaf95529efcce6ba9bb10c0ec3be94bce821617))
* **docs:** a parity page drawn from what each adapter declares, held by the checks (T4618) ([3f318a3](https://github.com/teamrig/teamrig/commit/3f318a3720ea79358d98d6f4b9a7735084eb8b57))
* **features:** a third feature side, terminal, with a row per request of the terminal protocol ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([5e8d007](https://github.com/teamrig/teamrig/commit/5e8d0071d1a5136f2dd6871c092a825e0aee7ab6))
* **features:** rows for pools, windows, tuning, refresh, wake cost, tab memory, start size and error kinds (T4743) ([c804285](https://github.com/teamrig/teamrig/commit/c8042854cf0b94e36f28838c7dd3c446ef8d8266)), closes [#1884](https://github.com/teamrig/teamrig/issues/1884)
* **features:** rows typed by their side, and the two kinds of connector as a list (T4618) ([1efac46](https://github.com/teamrig/teamrig/commit/1efac46b975efc6dfbf12fa7f8ccb2abe85d7290))
* **features:** the feature registry names every host and connector feature (T4618) ([3f78435](https://github.com/teamrig/teamrig/commit/3f7843562e75499efbedba17a842c63f0cf30126))
* **github:** a gh runner and a program runner read as each other ([#1885](https://github.com/teamrig/teamrig/issues/1885)) ([f64f3b2](https://github.com/teamrig/teamrig/commit/f64f3b2962c6f86a569bc6c8260cf9d79e61d23f))
* **hooks:** a model notice file reads in the next format, naming the tab hostSession (T4762) ([b7d8c0c](https://github.com/teamrig/teamrig/commit/b7d8c0c1e981060e92fc5b282e0ed61bb56fd043))
* **hooks:** name the teamrig command for each raw gh write (T4819) ([41a7214](https://github.com/teamrig/teamrig/commit/41a72149a5aa1bda6a911560b8a937f6143a216f))
* **hooks:** read a raw gh call as a read or a write, and where a write lands (T4819) ([bedcfd1](https://github.com/teamrig/teamrig/commit/bedcfd1bda2fee96193e4bce71dab5ebaa9efcf9))
* **hooks:** the cold-send log counts a hold whose line names the tab hostSession (T4762) ([40d16fc](https://github.com/teamrig/teamrig/commit/40d16fc592b62edd633aca0f63db32b7993aefbf))
* **hooks:** the exec guard refuses a raw gh write on the team's GitHub repositories (T4819) ([0e9084b](https://github.com/teamrig/teamrig/commit/0e9084b80eac1ca445055b3964ffd196217efe68))
* **hooks:** the hint log counts a hint whose line names the tab hostSession (T4762) ([57d2d4d](https://github.com/teamrig/teamrig/commit/57d2d4d17bfdfbc08c4152806fca4229d17f6636))
* **host:** the usage meter reads the plan's week and five-hour windows (T4750) ([5fcad22](https://github.com/teamrig/teamrig/commit/5fcad22568c23959ed6cdb41194386e7495ce45e)), closes [#1988](https://github.com/teamrig/teamrig/issues/1988)
* **inbox:** a mark of the next format reads, naming the tab hostSession (T4762) ([a106df4](https://github.com/teamrig/teamrig/commit/a106df400fb1a05030a3594d820425043d595a60))
* **issues:** a tracker names each label as it holds it, so Jira takes the status labels with a space (T4754) ([b09548a](https://github.com/teamrig/teamrig/commit/b09548a1603fe9b83137ac2e7424e2f1265f78a2))
* **issues:** read one issue or pull request as it is now (T3169) ([5a4ecf6](https://github.com/teamrig/teamrig/commit/5a4ecf6776fa8d2694a208d0ece1ad413d788fee))
* **issues:** send a maintainer reply with the state it names, the comment last (T3169) ([ead68ab](https://github.com/teamrig/teamrig/commit/ead68ab14cf50f66714ff3c4a16b2bfa0d8f1291))
* **jira:** a client signs each request in with the site's saved credential, waits out a rate limit and reads the answer to one of three ends (T4754) ([dfdad67](https://github.com/teamrig/teamrig/commit/dfdad67e610ffb00c6d6b21a3f27da970ea1f5d3))
* **jira:** a closed Jira issue's reason reads in the port's words, by what its resolution is named (T4754) ([c38071a](https://github.com/teamrig/teamrig/commit/c38071ab819a229df3c4e36689ae71669ba305f2))
* **jira:** a project is &lt;site&gt;/&lt;key&gt;, with its API root, credential name and issue keys (T4754) ([3824903](https://github.com/teamrig/teamrig/commit/3824903fc13d664b561e43e5e45f725a0147ee90))
* **jira:** assigns an issue to one account and takes it off, by account id (T4754) ([61f0260](https://github.com/teamrig/teamrig/commit/61f0260c103b06392400937701669fd38664ff32))
* **jira:** closes an issue by a transition to a closed status, with the resolution its reason is named by (T4754) ([85a31ee](https://github.com/teamrig/teamrig/commit/85a31eeb017c263fd5c2fb39522f58a95613d80a))
* **jira:** Jira's document format read to plain text and written from it, the credit as its last paragraph (T4754) ([3c3f63e](https://github.com/teamrig/teamrig/commit/3c3f63ed4bccb8e21425633f51ec0155546bfe39))
* **jira:** opens an issue as the project's Task, or its first type that is no sub-task (T4754) ([94ee3b2](https://github.com/teamrig/teamrig/commit/94ee3b246638790e1666d32f850ab438f92830e7))
* **jira:** reads Jira's own id of an issue, so a duplicate's close names an original Jira shows (T4754) ([fef16a8](https://github.com/teamrig/teamrig/commit/fef16a8d29d2c5597486d60e484d7ec893b9c5d1))
* **jira:** reads one issue as it is now, for a reply (T4754) ([7e14b5c](https://github.com/teamrig/teamrig/commit/7e14b5cbd2bc37502442863419005a397e1de525))
* **jira:** the Jira adapter enters the adapter table, its tracker built over the HTTP port and the site's saved credential, and the parity page draws its column (T4754) ([002161e](https://github.com/teamrig/teamrig/commit/002161e88b6cae6ce88499ebc47771c67eed1e18))
* **jira:** the Jira declaration says how far each tracker feature goes today, with no proof claimed (T4754) ([b61cd76](https://github.com/teamrig/teamrig/commit/b61cd76f29f327cfe393289ceee0d52bb6a1e9b1))
* **jira:** the Jira tracker lists a project, watches it, comments, replaces a description and sets labels, and answers a not-built method with its line (T4754) ([f3124d0](https://github.com/teamrig/teamrig/commit/f3124d0acdedbe2151d994015c42b86eea845d72))
* **permissions:** a service role holds no bare comment, as a reply takes the thread's state with its words (T3169) ([51f450b](https://github.com/teamrig/teamrig/commit/51f450b2e66c3682021f7231ed9086491e7bcd5f))
* **plugin-api:** a connector adapter is handed the HTTP client (T4754) ([bca7339](https://github.com/teamrig/teamrig/commit/bca73392d7808ff6359470d422f2fcc72485f9e7))
* **plugin-api:** a terminal adapter's entry, as a host and a connector have theirs ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([4563709](https://github.com/teamrig/teamrig/commit/4563709ddf40e9dfabe86ede12179f05e0cb3ebe))
* **plugin-api:** a tracker adapter gets the port's result types, the JSON guards, the claim line and the stamp's parts (T4754) ([5f07e28](https://github.com/teamrig/teamrig/commit/5f07e2833733f6cd5796e4a30bb84bf212a29ecf))
* **plugin-api:** the terminal port, request for request the terminal protocol ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([95fba30](https://github.com/teamrig/teamrig/commit/95fba303696dc8439579f2319d7e58bbafeefdee))
* **plugin-api:** the versioned surface adapters build on (T4618) ([6b2e489](https://github.com/teamrig/teamrig/commit/6b2e48939e6707c7cf1022268473b0b727e29411))
* **refresh:** the restart files read in the next format, naming the tab hostSession (T4762) ([d8162f2](https://github.com/teamrig/teamrig/commit/d8162f2189099a167370a35f45ae568991241b49))
* **register:** a command reads the descriptions of the cards it prints from the history (T4781) ([1b05081](https://github.com/teamrig/teamrig/commit/1b05081a9115c5c427537a769110ae1113811ce5))
* **register:** a snapshot's task lines leave descriptions out (T4781) ([2b1dbfd](https://github.com/teamrig/teamrig/commit/2b1dbfd77dced975282b6b0d7d4e2504a97b8e1f))
* **register:** a task holds the mark of a description its task line left out (T4781) ([869259d](https://github.com/teamrig/teamrig/commit/869259d62e71644d1d8073578922f72aaf0622c6))
* **restore:** a restore entry reads with its session named hostSession (T4762) ([d74c2e5](https://github.com/teamrig/teamrig/commit/d74c2e56b3f7141bc81370f22ac8fafce7024e66))
* **secret-guard:** a pending history clean reads with its session named hostSession (T4762) ([41a42dd](https://github.com/teamrig/teamrig/commit/41a42dd7d6fedbf02bde065f04c3571ccca45707))
* **sessions:** a session record reads in the next format, naming the tab hostSession (T4762) ([489d89c](https://github.com/teamrig/teamrig/commit/489d89ce492e2ccb026180ef59f6438e1bc7c3a5))
* **sessions:** the session log reads the next format, naming a close's tab hostSession, and writes beside it (T4762) ([a9905a9](https://github.com/teamrig/teamrig/commit/a9905a90a878dc6060b71cc1d41db89867421957))
* **ship:** list a base's open pull requests with their head repo, and close one with a comment (T4780) ([23a9516](https://github.com/teamrig/teamrig/commit/23a9516f9459e094b7e5a0d3c6f630caf7d75fc7))
* **testing:** describeContracts runs an adapter's contract cases as its spec ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([8752c42](https://github.com/teamrig/teamrig/commit/8752c42d2924e015f2c56c0ad72b8be2e2ae8587))
* **turn-log:** a turn log line reads in the next version, naming the session hostSession (T4762) ([926fccf](https://github.com/teamrig/teamrig/commit/926fccfff5aaf0739778de19e3d180f61aab9f0d))


### Bug Fixes

* **ci:** the boundary check lets an adapter's spec bind from the conformance kit (T4750) ([10ef10f](https://github.com/teamrig/teamrig/commit/10ef10fec23a06c681cfe7a0621fad83a7cedc98)), closes [#1988](https://github.com/teamrig/teamrig/issues/1988)
* **conformance:** a named window is a terminal row of its own, out of the open case ([#1984](https://github.com/teamrig/teamrig/issues/1984)) ([bb5afac](https://github.com/teamrig/teamrig/commit/bb5afacfe7e8cb38397a153c3a17ec60261d7e35))
* **decisions:** the batch prints a cut card's what and why from the history (T4781) ([38bd420](https://github.com/teamrig/teamrig/commit/38bd42009954874e8b95639f38a5b2c119d6771b))
* **features:** the comment row names issue reply (T4743) ([3c985df](https://github.com/teamrig/teamrig/commit/3c985dff07e5ce734c694e3ff20cb703b0a3dcc3)), closes [#1884](https://github.com/teamrig/teamrig/issues/1884)
* **github:** a sync judges a cut task's description by its mark (T4781) ([ba1ad7a](https://github.com/teamrig/teamrig/commit/ba1ad7a8337423db472a2cd01089fb91eb7a7ec4))
* **github:** the watcher defaults to the holder of issue close, as no role holds a bare comment (T3169) ([afd2197](https://github.com/teamrig/teamrig/commit/afd21971d037beb27423ae4cc8204291630d97a7))
* **hooks:** the gh write guard fails closed on a -R before the command, placeholders, dynamic words and unread remotes (T4819) ([b80242f](https://github.com/teamrig/teamrig/commit/b80242f946f582b019875ec631760723ab2114a1))
* **issue:** issue similar compares a cut issue's body from the history (T4781) ([efec98d](https://github.com/teamrig/teamrig/commit/efec98daac1d7dc849cfca14c69b1a12a43c66c3))
* **issues:** a reply's status push assigns as the repository push does (T3169) ([a121ae2](https://github.com/teamrig/teamrig/commit/a121ae2982eed84e6373605695594905285b39c4))
* **issues:** the one-issue push plan and reply's set carry the fields main added since (T3169) ([3042d11](https://github.com/teamrig/teamrig/commit/3042d11d3dcd1877d56e291d4674edfe1fa3c3be))
* **meeting:** the agenda prints a cut card's what and why from the history (T4781) ([643e0b3](https://github.com/teamrig/teamrig/commit/643e0b30d8b947821b5f5b9f46697f4c86a827b5))
* **meet:** meet --cards prints a cut card's what and why from the history (T4781) ([7e68967](https://github.com/teamrig/teamrig/commit/7e689672d3305278eac6f0248e9dd153753af1eb))
* **open:** the hidden-console spec waits on the program's own output, and says what it read ([719f903](https://github.com/teamrig/teamrig/commit/719f903bc8b3ea4576f6452efb42a81e57dd4f10)), closes [#1977](https://github.com/teamrig/teamrig/issues/1977)
* **prompt-hold:** a page names the tool and the program only, never an argument (T2963) ([4a6087e](https://github.com/teamrig/teamrig/commit/4a6087ecacc13253f97c4052e6b84f184a51da51))
* **register:** the import judges a cut task's description by its mark (T4781) ([2640b84](https://github.com/teamrig/teamrig/commit/2640b8472772b868504c788efff45ab3339c3729))
* **ship:** a merge and ship.ts pr close the pull requests their head replaces (T4780) ([5a15aed](https://github.com/teamrig/teamrig/commit/5a15aed136155aa6659437c0c623519f41357718))
* **ship:** a plugin manifest is a version file by its shape, so teamrig-pane's release reads as teamrig's (T4821) ([07fe809](https://github.com/teamrig/teamrig/commit/07fe809974a11d879be863d94c3df21846289855))
* **ship:** close the older same-stem pull requests whose work a newer head carries (T4780) ([c5a4423](https://github.com/teamrig/teamrig/commit/c5a4423ec00446e9e24cd25b66cf70420403b9aa))
* **ship:** repos.json names teamrig-pane's release pull request, so ship.ts merge --release lands it (T4821) ([874c9bd](https://github.com/teamrig/teamrig/commit/874c9bd2b6eee2a96390ac4ddca11035ed050106))


### Performance Improvements

* **ci:** a short proof also runs the commit rules, and every check when a change touches the gate itself (T4080) ([51fc979](https://github.com/teamrig/teamrig/commit/51fc9798b16e2dfb0a14c5fff06e9acff7bf5440)), closes [#1518](https://github.com/teamrig/teamrig/issues/1518)

## [0.496.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.495.1...teamrig-v0.496.0) (2026-11-20)


### Features

* **ci:** a change-kind tool names a CI run's change code, docs or design (T4617) ([4642445](https://github.com/teamrig/teamrig/commit/46424452cbb9fbd663cec21b2bf4524673d6428e))
* **issues:** count the status push's writes over the rolling hour (T4592) ([b89ec7b](https://github.com/teamrig/teamrig/commit/b89ec7beec5ff4f73456ac1ffe1157bf4d8c8311))
* **issues:** issue label makes a missing label github.areaOwners names (T4053) ([005be3e](https://github.com/teamrig/teamrig/commit/005be3ec3d55c6b7674e9b04519ddcfb3bcfa035))
* **issues:** the automatic push sends what the hour has left, not an even share (T4592) ([eb0d394](https://github.com/teamrig/teamrig/commit/eb0d394a7eb51f91a539bbe17d8f5710c4fdbaaf))
* **register:** a snapshot holds each kept task as one line and only two days of events (T4076) ([54a19ba](https://github.com/teamrig/teamrig/commit/54a19ba9c3cc4f4a7e64e01b3d2af8fc8cce5da9))
* **register:** a task's folded state as one snapshot line, read back exactly (T4076) ([e9d5881](https://github.com/teamrig/teamrig/commit/e9d58811d6ea44674ce0bfad42f49997d95c078c))
* **register:** the issue migrate role's holder links any team task to its issue ([7916b7a](https://github.com/teamrig/teamrig/commit/7916b7a57ddf8a6085051b9b15c2df5a0f377b34))
* **roles:** issue migrate is a service command a role may give ([2184b9a](https://github.com/teamrig/teamrig/commit/2184b9aff5448c8131478e75e89839088251b59b))
* **ship:** a merge on a merge queue repo enqueues the checked head and waits for the queue to land it, with no landing turn (T3386) ([5b90352](https://github.com/teamrig/teamrig/commit/5b90352ee80e9f46e7ef85dfe8a47ae8976a670b))
* **ship:** a merge queue landing enqueues the approved head and waits for GitHub to land or eject it (T3386) ([91df090](https://github.com/teamrig/teamrig/commit/91df0905a73c8e67e4c31e3d300c551f96487640))
* **ship:** a merge stops waiting for a conditional check its run left out once the summary passed (T4617) ([ecb9226](https://github.com/teamrig/teamrig/commit/ecb92267126d546b8b46a9c109055feabe8de064))
* **ship:** release-pull.ts reads whether a release pull request holds only a release (T4645) ([21a0048](https://github.com/teamrig/teamrig/commit/21a0048f88ad7dd6236a9a815cf4b6a8bed0f5d9))
* **ship:** repos.json names a repo's release pull request branch and changelog (T4645) ([da347c5](https://github.com/teamrig/teamrig/commit/da347c549f60584b6c30f7688f439ab504d9a98e))
* **ship:** repos.json says whether main merges through GitHub's merge queue (T3386) ([9a1315c](https://github.com/teamrig/teamrig/commit/9a1315cf8a32be90046caea0ec0f22277eb0d013))
* **ship:** ship.ts merge --release merges the release pull request on its release task's approval (T4645) ([63aeaad](https://github.com/teamrig/teamrig/commit/63aeaaddaa3c7e51dc6f0ee6196e4291bc3da4ed))


### Bug Fixes

* **check:** LOG-SIZE names each file's own remedy, not teamrig compact for every one (T4686) ([112a72e](https://github.com/teamrig/teamrig/commit/112a72ed6407107c608b6fd4280e6c0963798a5c))
* **ci:** change kind runs the base commit's classifier, never the change's own (T4617) ([78f3c1c](https://github.com/teamrig/teamrig/commit/78f3c1c3c55d7100d62eaf899b1096692af179b9))
* **github:** the issue templates link the outside guide under the org repository (T4326) ([c06f850](https://github.com/teamrig/teamrig/commit/c06f850114da5609f7946bab780968305b09523c))
* **github:** the issue templates link the security advisory form of the org repository (T4326) ([570745c](https://github.com/teamrig/teamrig/commit/570745c62a61c0d65b5389935b5c502619a16703))
* **hooks:** resolve . and .. in a path, not across a command's words ([6c7f4cb](https://github.com/teamrig/teamrig/commit/6c7f4cbe0a2259d1c249f0b4569200fb57743b74))
* **leader-digest:** read a snapshot of task lines, and the history for a cursor before its window (T4076) ([f6d5a37](https://github.com/teamrig/teamrig/commit/f6d5a37ea5a30fb6ae927e706d6c265b46c364bf))
* **meeting-end:** read the history for a meeting that started before the snapshot's event window (T4076) ([7cd689d](https://github.com/teamrig/teamrig/commit/7cd689d7d6688d77d0e313a92695eada834e690f))
* **permissions:** a release merge is a ship role call, so the lead-approved release needs no permission prompt (T4672) ([c988e3c](https://github.com/teamrig/teamrig/commit/c988e3cdd1d4846f4214b61b8f62ade35aff3e91))
* **queue:** a ship holds the slot of the repository its words move, or every slot when in doubt ([#1711](https://github.com/teamrig/teamrig/issues/1711)) ([e91c673](https://github.com/teamrig/teamrig/commit/e91c6735a2d7f18b92e2b2ea91d7d1f5a7446dbf))
* **queue:** a ship step of one word, a whole shell line, holds every slot ([#1711](https://github.com/teamrig/teamrig/issues/1711)) ([ddc27f3](https://github.com/teamrig/teamrig/commit/ddc27f3bc7f965da274e946b4e029cefd56baef9))
* **queue:** a ship step whose program is a script of another repository holds every slot ([#1711](https://github.com/teamrig/teamrig/issues/1711)) ([8562fe9](https://github.com/teamrig/teamrig/commit/8562fe9860254307296dd5702bffb6b981742067))
* **queue:** hold the ship slot per repository, not per host ([#1711](https://github.com/teamrig/teamrig/issues/1711)) ([039ed66](https://github.com/teamrig/teamrig/commit/039ed66a0a3c49063708b8f17aa270096d1223d2))
* **register:** the issue migrate holder never lifts a task kept local (T4606) ([f296bac](https://github.com/teamrig/teamrig/commit/f296bac985b3f5b4a75ff8f541f8f0babf2be4cf))
* **roles:** a migrate counts each issue row toward the daily cap (T4606) ([68c7560](https://github.com/teamrig/teamrig/commit/68c7560d95b4f24edfb85c9869aa7161fc168a1a))
* **ship:** a merge-queue landing waits on or reports merged only the approved head (T4681) ([4bb7ec1](https://github.com/teamrig/teamrig/commit/4bb7ec147077246ba18f84eb8dd5a7dfef4a08e5))
* **ship:** count the tab check runCli runs before step-away as ship code ([#1686](https://github.com/teamrig/teamrig/issues/1686)) ([08e7934](https://github.com/teamrig/teamrig/commit/08e79346792e4289521998f11fa07c8e1aa51bd9))
* **ship:** the start check counts only the CLI commands the ship runs ([#1686](https://github.com/teamrig/teamrig/issues/1686)) ([69a212a](https://github.com/teamrig/teamrig/commit/69a212a752cd73a64e3088da678cc1e48582389b))
* **ship:** the teamrig-pane profile waits for its commit subject gate, not the plugin version gate it dropped (T4678) ([5d740ca](https://github.com/teamrig/teamrig/commit/5d740ca4a02aa427438c977318445dae9023ac19))
* **show:** judge a task's need for the history with windowOpensAfter (T4076) ([5e3769e](https://github.com/teamrig/teamrig/commit/5e3769efbb7b6fef4a754aa00d0f62ecf185dd76))
* **show:** read the history for a task created before the snapshot's event window (T4076) ([054dcab](https://github.com/teamrig/teamrig/commit/054dcab9ae50bbab750d59e54228d9459c3150e1))
* **starter-watch:** list the starters once more when a listing failed or left them out ([#908](https://github.com/teamrig/teamrig/issues/908)) ([797000a](https://github.com/teamrig/teamrig/commit/797000a88466e864bcff08533351065f67b0d4be))
* **team-split:** move a task created before the snapshot's event window with all its lines (T4076) ([8f9c9d6](https://github.com/teamrig/teamrig/commit/8f9c9d67b02b208b0e602149b7a81ec71241eaeb))

## [0.495.1](https://github.com/teamrig/teamrig/compare/teamrig-v0.495.0...teamrig-v0.495.1) (2026-11-19)


### Bug Fixes

* **ship:** a waiting ship's tool is checked against the remote's own head at its start ([#1466](https://github.com/teamrig/teamrig/issues/1466)) ([8cd2ce5](https://github.com/teamrig/teamrig/commit/8cd2ce581dcacb0f08b7c07e112212b7ea80f97b))

## [0.495.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.494.0...teamrig-v0.495.0) (2026-11-19)


### Features

* **github:** read the login the token belongs to (T4581) ([f7c8410](https://github.com/teamrig/teamrig/commit/f7c8410e0366ecaedb98cdd01c4d688d5b094fe1))
* **inbox:** a line naming a p0 sent to many sessions wakes only those who act on it (T4431) ([1b99895](https://github.com/teamrig/teamrig/commit/1b998954976c419ca04045c81e62be5c61b0354f))


### Bug Fixes

* **ci:** the pre-push light checks build the dist before the plugin's tests, which load it (T4595) ([6938809](https://github.com/teamrig/teamrig/commit/6938809267b68c9dd62d8c9905a5bc23e16a0615))
* **issues:** the status push assigns the login the sync runs as, never the repo owner, and a refused assign costs no write (T4581) ([1dea906](https://github.com/teamrig/teamrig/commit/1dea906439880449c704ac64440893bec6c4f46e))
* **push-guard:** a program that may set variables unseen cuts only what runs after it ([ab4d090](https://github.com/teamrig/teamrig/commit/ab4d0909b8c64cf60580a3a5d3320350519bb6f3))
* **push-guard:** resolve a redirection target a line's variable names ([b4d6297](https://github.com/teamrig/teamrig/commit/b4d62972902840466ecf9868033eb20af09e8a41))
* **push-guard:** test a heredoc stored through a variable path ahead of an unknown program ([276b225](https://github.com/teamrig/teamrig/commit/276b225bb940aee0f7e2497a5611db79d2edde01))
* **register:** a proof may wait on its owner's own open task ([#1544](https://github.com/teamrig/teamrig/issues/1544)) ([029aadd](https://github.com/teamrig/teamrig/commit/029aaddf6d85e7f16ecf28f6317040faf6c03c12))
* **register:** a proof waits on its owner's open task only once every --after task is finished ([#1544](https://github.com/teamrig/teamrig/issues/1544)) ([3b4e92e](https://github.com/teamrig/teamrig/commit/3b4e92e096d84600ca661b969a718e35253dc378))

## [0.494.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.493.0...teamrig-v0.494.0) (2026-11-19)


### Features

* **cli:** teamrig issue assign gives one item to its takers ([74b4908](https://github.com/teamrig/teamrig/commit/74b4908f98bebfd73b2b49f2cd9849209214ac6b))
* **github:** the host reads whether a login may be assigned to one item, and the labels it carries ([882d113](https://github.com/teamrig/teamrig/commit/882d113cdae52a361757b3cf824551743f94a095))
* **github:** the runner takes the read of whether a login may be assigned to one issue ([e03f0f5](https://github.com/teamrig/teamrig/commit/e03f0f5773b8a1b2f6fe12fd538c807efe28fc88))
* **issues:** an assign gives an item to its takers, refused on a design issue or for one the host would drop ([023e47b](https://github.com/teamrig/teamrig/commit/023e47b05f78b1dbfcdc547db7a724efa98baaed))
* **marketplace:** installs read the release branch's plugin folder (T4355) ([5d06636](https://github.com/teamrig/teamrig/commit/5d0663647ae5f1fef49ca1dd38bb0837a200ddb9))
* **ship:** ship.ts pr opens the pull request of an approved, pushed head with the ship token (T4364) ([5c236b8](https://github.com/teamrig/teamrig/commit/5c236b8bb070af5dc91f3e49facb9bf712b64d81))


### Bug Fixes

* **config:** config get shows every key the config guard refuses as owner-gated ([#1470](https://github.com/teamrig/teamrig/issues/1470)) ([c993030](https://github.com/teamrig/teamrig/commit/c993030d56f2ab8e6bf7aa253123b709d8b3a2cb))
* **queue:** a memory wait line says the floor is kept free for the host, not the step's need ([#1670](https://github.com/teamrig/teamrig/issues/1670)) ([53d32e7](https://github.com/teamrig/teamrig/commit/53d32e7f5704cec4b899013efb5185796065b1ab))
* **queue:** a re-run's label matches its first run, a re-run word set aside ([#1670](https://github.com/teamrig/teamrig/issues/1670)) ([781e4b6](https://github.com/teamrig/teamrig/commit/781e4b68a9a2c307c37be0fc177e28d7e526d0be))
* **queue:** one outlier run no longer pins a step's memory need, and re-runs match by label without commit ids ([#1670](https://github.com/teamrig/teamrig/issues/1670)) ([5f31192](https://github.com/teamrig/teamrig/commit/5f31192684c528e3aac6bf9f11a5e5160123eeb0))
* **ship:** a ship and a catch-up commit the dist only while the tree tracks it (T4355) ([fe47ef7](https://github.com/teamrig/teamrig/commit/fe47ef7eea2c81edf760fb4334405cb6b86641c6))

## [0.493.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.492.0...teamrig-v0.493.0) (2026-11-19)


### Features

* **budget:** budget.resets lists the person's other Claude accounts as kind account, free again a week after each switch (T939) ([1ddec6b](https://github.com/teamrig/teamrig/commit/1ddec6b70a6ef673fc50b71c96da766408fb2144))
* **check:** name a session left ready with no restart coming ([#705](https://github.com/teamrig/teamrig/issues/705)) ([0664f17](https://github.com/teamrig/teamrig/commit/0664f1790844fd0df6a8c312b92529492227264a))
* **check:** UNKNOWN-GOAL flags a task whose goal tag has no record ([#846](https://github.com/teamrig/teamrig/issues/846)) ([bb30ae4](https://github.com/teamrig/teamrig/commit/bb30ae4d3088353104f5c3efdca94a607da0263b))
* **cli:** every command takes --session and --team ([#654](https://github.com/teamrig/teamrig/issues/654)) ([b5ab4f3](https://github.com/teamrig/teamrig/commit/b5ab4f338226f369cb7b763b6a62eb6b4ad11b33))
* **cli:** the status push sets each held issue's fields and type after its labels (T3406) ([3aca51e](https://github.com/teamrig/teamrig/commit/3aca51e0180b06b3eda3f09bc83e3d290be14d26))
* **config:** github.fields names the issue fields, priority options and types the status push sets (T3406) ([5f0753b](https://github.com/teamrig/teamrig/commit/5f0753be18822880668d557052827cb701e3ebb5))
* **config:** the lead may set github.watcher, one of the sessions (T3447) ([415261e](https://github.com/teamrig/teamrig/commit/415261e16c9d943f323fb009d8badc12a1659e35))
* **github:** read each open issue's fields and type, and write them on the owner's token (T3406) ([66bcef0](https://github.com/teamrig/teamrig/commit/66bcef0848edfd7800962fb099fd4952821c19b2))
* **github:** the allowlist takes one issue field value write and one issue type write, word for word (T3406) ([0dbe0e8](https://github.com/teamrig/teamrig/commit/0dbe0e8d1560310f58d53e877c877f04fe6dd726))
* **github:** the response clock groups its reminders per owner and GH-LATE per check ([#1475](https://github.com/teamrig/teamrig/issues/1475)) ([b64829c](https://github.com/teamrig/teamrig/commit/b64829cbd2a4ae41cdae07d1352a50b72a55300e))
* **inbox:** a line naming unfinished right-now work wakes as --wake now (T4414) ([5fcd904](https://github.com/teamrig/teamrig/commit/5fcd904bd6c4c8c168a76da7b8da95381ae0f493))
* **issues:** an optional fields capability on the tracker port, and the one-way field and type plan (T3406) ([12bc0a1](https://github.com/teamrig/teamrig/commit/12bc0a195c45f37145f76090666941c1c0db946c))
* **register:** a task tree names the sessions a task waits on and what of each (T4414) ([3092344](https://github.com/teamrig/teamrig/commit/3092344cac5de7fe8478aca8cc619ab0ebefa408))
* **ship:** a pull request already open without its Reach section merges with a warning line ([d152005](https://github.com/teamrig/teamrig/commit/d15200588ce6d0e53debe5d4a5900db0c7225e5b))
* **ship:** a repo profile lists the sections a pull request note must hold ([d8b230a](https://github.com/teamrig/teamrig/commit/d8b230ae9f75d2b8c2ac7fa146a0be34feb2c397))
* **ship:** merge opens no teamrig pull request without its Reach section (T3058) ([cc31aa5](https://github.com/teamrig/teamrig/commit/cc31aa5f341c9323f781f5d0acd1d3cf904ee22a))


### Bug Fixes

* **check:** RESTART-STALLED skips a ready session whose Claude Code is gone ([#705](https://github.com/teamrig/teamrig/issues/705)) ([a6182e4](https://github.com/teamrig/teamrig/commit/a6182e437a9446ed3af5db1069dc1babef0c3995))
* **ci:** a release run that opens no release pull request passes (T4347) ([6bea29c](https://github.com/teamrig/teamrig/commit/6bea29c811753f838a4ffc5a708c1078cfc07feb))
* **ci:** the pre-push hook runs light checks and leaves the suite to CI (T4344) ([6f8019e](https://github.com/teamrig/teamrig/commit/6f8019e7c82bf89e9d95908c005b1422870352a7))
* **cli:** a command never sees a --session or --team it does not declare ([#654](https://github.com/teamrig/teamrig/issues/654)) ([ed3f9e6](https://github.com/teamrig/teamrig/commit/ed3f9e6f4da1b0a3c48f6f64c57124d7a6630b9f))
* **cli:** undeclared --session/--team stay out of flags as the line is read, and --session is checked on the team the command runs for ([#654](https://github.com/teamrig/teamrig/issues/654)) ([c8000af](https://github.com/teamrig/teamrig/commit/c8000aff8dbf5a11d9347be310be3c31c0013071))
* **github:** a grouped GH-LATE keeps its key when its newest late thread is answered ([#1475](https://github.com/teamrig/teamrig/issues/1475)) ([1939eb0](https://github.com/teamrig/teamrig/commit/1939eb00d5e7381d18918f28f7add414542ec308))
* **idle:** a closed session asked to wake for right-now work keeps its place first in the reopen line (T4414) ([3f78fa2](https://github.com/teamrig/teamrig/commit/3f78fa228d903d1fe0120abf7c9e7e0105ae30db))
* **idle:** a closed session reopens for right-now work of others that waits on it (T4414) ([78d245b](https://github.com/teamrig/teamrig/commit/78d245bbc2b93377db04f8f1b053752615d7cb86))
* **issues:** the status push names a task on an open pull request as one, not as unlisted ([#1451](https://github.com/teamrig/teamrig/issues/1451)) ([de09404](https://github.com/teamrig/teamrig/commit/de09404d783ba3f3f5ee8942a962113834878fa6))
* **meeting:** one spotlight dims the host at a time, so a second meeting lifts the first's (T4294) ([5739de0](https://github.com/teamrig/teamrig/commit/5739de016998f1c9bbdb670afdccbcac620cabe7)), closes [#1674](https://github.com/teamrig/teamrig/issues/1674)
* **push-guard:** read the jobs builtin's -x form as a launcher and an unseen setter (T4423) ([7fd91a2](https://github.com/teamrig/teamrig/commit/7fd91a28c7d689c286942593d2ad299cc1e876c5))
* **queue:** a step's time limit leaves out the time its share was set aside (T4218) ([768212f](https://github.com/teamrig/teamrig/commit/768212f4b7b8dfe8cde7a880dc01fe7cca70b204))
* **register:** a note-only set points to update --note ([#701](https://github.com/teamrig/teamrig/issues/701)) ([4a325fb](https://github.com/teamrig/teamrig/commit/4a325fb1c8fb61edea634819bd6fd4a8d92d65aa))
* **register:** right-now work handed to a closed owner reopens it at once, and its NOTE no longer says it is woken at an idle prompt (T4414) ([124f978](https://github.com/teamrig/teamrig/commit/124f978e5ff0b41bc2d2409fa5bb8e48b049519f))
* **register:** right-now work waiting on a session wakes it, and reopens it when closed (T4414) ([da63252](https://github.com/teamrig/teamrig/commit/da632523ea79505a1eef7e32e5ba2f392e8ddc58))
* **ship:** a merge reads an approved head's work by the version files the ship sets again, the release manifest too (T4298) ([27dbeae](https://github.com/teamrig/teamrig/commit/27dbeae96baca58b1ee06c5ba73ddd4900a44c9b))
* **ship:** a merge's drift check retries a fetch that lost a ref race, and one that cannot read keeps exit 0 ([#1452](https://github.com/teamrig/teamrig/issues/1452)) ([8f8c225](https://github.com/teamrig/teamrig/commit/8f8c225550b1a244b3f8f3c007aa4a2dff149b1a))
* **ship:** an empty plan ships the commits a branch already carries, so an outside pull request keeps its author (T4116) ([eeac703](https://github.com/teamrig/teamrig/commit/eeac703418d8888382e0c529b939c1b10963bb40))
* **ship:** only an older merge whose checks passed holds the landing turn (T4196) ([1192137](https://github.com/teamrig/teamrig/commit/1192137ed8f6c2d33e59d266e0058f46c51d8e15))
* **update:** the update check reads the version a git-subdir marketplace entry installs (T4355) ([5665f10](https://github.com/teamrig/teamrig/commit/5665f104d077965e857f58427b48c466a9bb0162))
* **wake:** a closed session's CLOSED line for right-now work says its reopen goes first (T4414) ([0b710cc](https://github.com/teamrig/teamrig/commit/0b710cc1008dbb2b535f3cd851f915318b4020fc))
* **worktree:** a branch id with a leading zero names no task (T3269) ([38355ba](https://github.com/teamrig/teamrig/commit/38355ba6d868e74efab5d9f97699b4b9a1e0fd8b))

## [0.492.0](https://github.com/teamrig/teamrig/compare/teamrig-v0.491.0...teamrig-v0.492.0) (2026-11-18)


### Features

* **budget:** budget cut --stop holds a session whatever its use, up to the week's reset (T3455) ([ec4cbee](https://github.com/teamrig/teamrig/commit/ec4cbeeef79b0368700dc08fda45634fd6db9cd4))
* **check:** warn the lead when a team log nears the task pane's read limit (T3482) ([dae2f01](https://github.com/teamrig/teamrig/commit/dae2f01d3fab306abddbbe168f277ab771d4f12a))
* **ci:** a short proof runs the scrub, DCO, typecheck and the changed files' specs, recorded apart from the pass record (T3414) ([d8a4440](https://github.com/teamrig/teamrig/commit/d8a4440b1a05ded6620f0fc3f7b47dadf2024ec1)), closes [#1372](https://github.com/teamrig/teamrig/issues/1372)
* **ci:** the pre-push hook proves a branch with the short checks when repos.json's merge switch is on (T3414) ([d0cdbff](https://github.com/teamrig/teamrig/commit/d0cdbffa7faf546a56d7849cb6ab68e59ca2dce9)), closes [#1372](https://github.com/teamrig/teamrig/issues/1372)
* **cleanup:** teamrig cleanup launchers lists orphaned tab launchers and ends them with --yes (T4108) ([0b22067](https://github.com/teamrig/teamrig/commit/0b22067f98bd55bed10fb88765cf66200a258341))
* **cli:** teamrig follow, follow --list and unfollow, the issues and pull requests a session follows (T3363) ([8ea2fc8](https://github.com/teamrig/teamrig/commit/8ea2fc805c44b05f26e5c383a579e316d5b848c8))
* **cli:** teamrig pipeline front puts a task's steps at the front of the host line (T4082) ([7a39dec](https://github.com/teamrig/teamrig/commit/7a39decfe8926077c2ab79948db6c3deb79800a8))
* **cli:** teamrig set --drop-approval gives up a task's approval for a new ask ([f315c72](https://github.com/teamrig/teamrig/commit/f315c7289531225118ea3cd152c363fbce966369))
* **cli:** teamrig step-away and step-back, run inside a queued step (T3336) ([0080370](https://github.com/teamrig/teamrig/commit/00803701add7710bfe7a0582b311dc6db6ea8b0c))
* **config:** github.activity and github.followMax, for the activity a session hears and the items it follows (T3363) ([99ad448](https://github.com/teamrig/teamrig/commit/99ad448bb277cc247736ef648f7d072a86a9cef7))
* **config:** prompts.hookAsks defaults to refuse, so no prompt holds a session by default (T3356) ([2a9d84c](https://github.com/teamrig/teamrig/commit/2a9d84c41194f4c5d4fa1381dbf803e1c392e2af))
* **delivery:** a fronted task's step goes first in the host line, and a request can be read again (T4082) ([8564148](https://github.com/teamrig/teamrig/commit/85641488cfb1ee9317a99a34925953af165bd982))
* **delivery:** a step waiting for the host lock reads its request again once a minute (T4082) ([598c7f6](https://github.com/teamrig/teamrig/commit/598c7f6d8290bd21b41f893950dbd585463e4a42))
* **delivery:** a store of the tasks the lead put at the front of the host line (T4082) ([a53f4a2](https://github.com/teamrig/teamrig/commit/a53f4a20d5ed5b864c944733fde44132b371c22b))
* **delivery:** a team's line requests read its register and front again at each read (T4082) ([bdf61af](https://github.com/teamrig/teamrig/commit/bdf61afbef0c17434d6a371882460b563d3f74bb))
* **env:** credentialsOf gives the credential variables of an environment (T4093) ([f2d7d91](https://github.com/teamrig/teamrig/commit/f2d7d91d904f7e2c18c186de3147bb740e22da96))
* **files:** the files port tells a file's size without reading it (T3482) ([2b82e78](https://github.com/teamrig/teamrig/commit/2b82e7874c2491abcec420f0e4036ecd53b50566))
* **github:** a pull request that closes a task's issue routes its posts, mentions and news to that task's owner, whatever its branch (T3363) ([5bd42a1](https://github.com/teamrig/teamrig/commit/5bd42a169e2c65475f03b20a64a9d9d93a3ed430))
* **github:** issue marks tell a watched issue's close, reopen and labels to its task's owner and its followers (T3363) ([fed0a40](https://github.com/teamrig/teamrig/commit/fed0a40c983130ad97889d83fb5d3695b9d722b4))
* **github:** pull request news reaches the owner of a task linking it and its followers, tells checks turning green, and wakes a session for changes requested on its own (T3363) ([a6bf55a](https://github.com/teamrig/teamrig/commit/a6bf55ad85cab72812cea654917345e239d6a033))
* **github:** route each new comment, review comment and review on a task's or a followed item to its sessions, a question waking the owner (T3363) ([ecceb7e](https://github.com/teamrig/teamrig/commit/ecceb7e1965fb65aec4bdcfdc7de2846608187b0))
* **github:** the auto sync tells a task's owner and its followers a watched issue's close, reopen and labels, in sync state format 6 (T3363) ([fee4225](https://github.com/teamrig/teamrig/commit/fee4225d2fae0dbf9f949f36e3ca5b21ff2f38d9))
* **github:** the automatic sync tells a task's owner and an item's followers each new comment, review comment and review, from the posts its mention scan reads (T3363) ([6b5646f](https://github.com/teamrig/teamrig/commit/6b5646f522f8088e27d7614866d611179af079d4))
* **github:** the follows store, the issues and pull requests each session follows (T3363) ([ab9ce39](https://github.com/teamrig/teamrig/commit/ab9ce3928454db3779cf7218e625104fcfc058f3))
* **git:** the merge git port reads many files at a commit in one git run (T4035) ([506a263](https://github.com/teamrig/teamrig/commit/506a263f033949a1e47d0e2dd18879e26fbcc374))
* **host-lock:** a queued step can set its host share aside and take it back in turn (T3336) ([1653ca4](https://github.com/teamrig/teamrig/commit/1653ca426e7b532635a52b0fa03f8adc9b937009))
* **idle:** a closed session reopens for a pile of inbox lines it has not seen, unless it rests; a closed child lead reopens on every trigger (T3387) ([d50eab2](https://github.com/teamrig/teamrig/commit/d50eab2ea3d4b6bff9bbcfab9d204021cddeccf6))
* **idle:** a tab's idle pass also runs the stale passes of its tree's other teams (T3387) ([c55c098](https://github.com/teamrig/teamrig/commit/c55c098177a0c84578cf024e5f9868a6aed9cc04))
* **merge:** read the checkout a file is in, naming a read git did not answer (T3368) ([0cddf61](https://github.com/teamrig/teamrig/commit/0cddf61b135aadc4ce6c2210e185a2eaa60820de))
* **open:** a launcher census reads every teamrig launch process and which lost their tab (T4108) ([6f2fc3b](https://github.com/teamrig/teamrig/commit/6f2fc3b8f5a07a76803bdaeec1e9127e1d456119))
* **processes:** SessionProcesses lists every process from one listing, and lineage reads it (T4108) ([3ea778c](https://github.com/teamrig/teamrig/commit/3ea778cc0ec7a044130a95f01b3d53e47f743b9c))
* **queue:** a parked step record a dispatcher claims once (T4093) ([61cdad4](https://github.com/teamrig/teamrig/commit/61cdad4646d483c20783337f5e45d7df3f3e7063))
* **queue:** a step can append its output to its own log (T4093) ([cb575a4](https://github.com/teamrig/teamrig/commit/cb575a486aa2369d471aa2db1a1b805d1c60c9a0))
* **queue:** queue and merge steps wait in the host line by their team's live requests (T4082) ([c373ecf](https://github.com/teamrig/teamrig/commit/c373ecf5436d1ad93ddcbe0c09838357e93b8cdc))
* **ship:** a merge of a repo whose main requires CI runs only the short checks before the push (T3414) ([e197de6](https://github.com/teamrig/teamrig/commit/e197de6afcb2e0f7621f2ab6035791f212d7ac8a)), closes [#1372](https://github.com/teamrig/teamrig/issues/1372)
* **ship:** repos.json says what a merge checks locally, the whole suite unless its main requires CI (T3414) ([ef0c316](https://github.com/teamrig/teamrig/commit/ef0c3163d8b25c2cac8df26d1c3b3d5ef5cf390b)), closes [#1372](https://github.com/teamrig/teamrig/issues/1372)
* **ship:** the ship gate proves a tree short with the runner's --short, its record kept apart (T3414) ([b4ec47a](https://github.com/teamrig/teamrig/commit/b4ec47a68e330b92ef0130e3f343498e7208ab59)), closes [#1372](https://github.com/teamrig/teamrig/issues/1372)


### Bug Fixes

* **admission:** a step that takes no ship slot passes every ship behind the one waiting on it (T3336) ([db419b8](https://github.com/teamrig/teamrig/commit/db419b80810248800d7899996009214c674f7dc6))
* **ci:** a local plugin-version run judges the raise against the fork point (T4254) ([d067d1f](https://github.com/teamrig/teamrig/commit/d067d1f6d261c5e25fd23020ca00bdf564ce14a4))
* **ci:** the coverage gate reports a run folder it cannot remove and goes on, never failing on it (T4233) ([02de774](https://github.com/teamrig/teamrig/commit/02de774ab2e1804da21c7b8b5eb3570d7a236e8f))
* **cleanup:** --yes ends an orphaned launcher only when its id keeps the same starter and start (T4108) ([c23ebff](https://github.com/teamrig/teamrig/commit/c23ebffaae2dc26750de14c70dd87b6a26af1ad7))
* **closed-wake:** a close the idle pass made a moment ago is no reopen under way ([#1584](https://github.com/teamrig/teamrig/issues/1584)) ([910195f](https://github.com/teamrig/teamrig/commit/910195f1ce991aadb1ff492efa07fcdbdd59d51c))
* **delivery:** the line front's model holds no file access; its store moves to line-front-store.ts (T4082) ([eb8cbfd](https://github.com/teamrig/teamrig/commit/eb8cbfdaa36a9cf1a6a41a28c19ed56e92566b1c))
* **git:** a git run records why git gave no answer, apart from git's own no (T3368) ([e1206c6](https://github.com/teamrig/teamrig/commit/e1206c646376264ab70c0bbc5a5e8ec53baf2bc7))
* **github:** a mention on an item a team task links to reaches that task's owner, not only an imported task's (T3363) ([cb183b4](https://github.com/teamrig/teamrig/commit/cb183b42d84baaa6da50e197cc87f5107242cdf9))
* **github:** an issue teamrig add opens follows github.stamp too ([#1102](https://github.com/teamrig/teamrig/issues/1102)) ([e7deab2](https://github.com/teamrig/teamrig/commit/e7deab2b9bdd6ecc11b122fef1dfef1f8ca6837a))
* **github:** an outside pull request opened is a plain line to the watcher, which defaults to the GitHub answerer (T3412) ([456d029](https://github.com/teamrig/teamrig/commit/456d02915b88746f632ea37926d79e4e7fa8c8f9))
* **github:** the response clock counts only the team's logins as our answer (T3380) ([a5223fc](https://github.com/teamrig/teamrig/commit/a5223fca091743ec0d6fee3970287fac095c4374))
* **hooks:** no teamrig guard ever asks a person; what it would ask about is refused with the route (T3356) ([b84df35](https://github.com/teamrig/teamrig/commit/b84df351809cac76e3a11916e740c8e1aed4e9f0))
* **hooks:** the drop-cd refusal no longer says to put the steps in a script file (T3291) ([ac95eea](https://github.com/teamrig/teamrig/commit/ac95eea93fe193bf39df36ca5aa5b1a1cea4f3d3))
* **host-lock:** a share an older teamrig took is kept, not set aside, as its release would leave it behind (T3409) ([bb707e8](https://github.com/teamrig/teamrig/commit/bb707e838fd063d829b63c73b0efbdfda6f2469c))
* **host-lock:** a share set aside is removed once its step's process is gone (T3409) ([195c86f](https://github.com/teamrig/teamrig/commit/195c86f8b28df604aa31bc61dc8fa4e9477e7dbb))
* **idle:** only the root team's lead is never closed; a leader stays open while a task waits on its answer or a session it leads runs (T3387) ([af20874](https://github.com/teamrig/teamrig/commit/af2087402bbfef337f48c09bdbe5de74506600a7))
* **issues:** a finished task never closes an issue taken outside the team, or a design issue (T3350) ([8e88928](https://github.com/teamrig/teamrig/commit/8e8892876dfe2006c0575933c963dff1fff33c6d))
* **issues:** issue links plans one link per issue pair, never one issue to itself (T3352) ([cf70e60](https://github.com/teamrig/teamrig/commit/cf70e601aa972ce4f996f57df9f2f6e59bac071c))
* **meet:** --terminal names the terminal searched for a running session's tab too ([#1514](https://github.com/teamrig/teamrig/issues/1514)) ([8d3ca0f](https://github.com/teamrig/teamrig/commit/8d3ca0fc951d6d50b80ccf5334eae259b165d99a))
* **open:** launcher census reads the entry script with win32 path rules, so a Windows command line matches on Linux and macOS (T4108) ([019e69d](https://github.com/teamrig/teamrig/commit/019e69d06a203e9828c4e92be76ef18dbd8eb93f))
* **open:** the keeper starts its program hidden too (T3369) ([bc48322](https://github.com/teamrig/teamrig/commit/bc483226e7a7836debbf0697c4851ef60191f588))
* **parked:** hasParked skips the files a dispatcher already found no step (T4093) ([44dbb1f](https://github.com/teamrig/teamrig/commit/44dbb1fa825c398c93b847b067e616c75807ff0a))
* **queue:** a dispatched step runs as its parker's Claude Code session, never the dispatcher's, and holds no messaging token (T4093) ([ad5f49c](https://github.com/teamrig/teamrig/commit/ad5f49cb8ca86d2f89b935c4aae2eef4e41b1366))
* **queue:** a ship tool run without --merge is a test step and takes no ship slot (T3414) ([67ea7ac](https://github.com/teamrig/teamrig/commit/67ea7aca81438e3d77db759912390f41763cdfd8)), closes [#1372](https://github.com/teamrig/teamrig/issues/1372)
* **queue:** a step passes every ship waiting while a ship holds the slot (T4333) ([817e755](https://github.com/teamrig/teamrig/commit/817e755c09822362863ffdaf0a9cb8af7f77c3eb))
* **queue:** a waiting ship is refused only when the code its tool runs changed, not when main moved on (T3419) ([2765ea0](https://github.com/teamrig/teamrig/commit/2765ea0fa53d23955d8872bc18acab798a95cd35)), closes [#1378](https://github.com/teamrig/teamrig/issues/1378)
* **register:** a restated approval wait keeps the approval unless its note names a new head (T3207) ([38971a4](https://github.com/teamrig/teamrig/commit/38971a461eb098fb79e63245fa0b5171d4623c51))
* **register:** a restated approval wait with no head is refused, naming the head that keeps the approval (T3094) ([c0c5da0](https://github.com/teamrig/teamrig/commit/c0c5da0a98d8b4c5418aec20befc8d23464d84d7))
* **register:** a set on an approved task keeps or refuses, never silently drops, its approval ([41e02ad](https://github.com/teamrig/teamrig/commit/41e02ad39845faf436bdbe8962bce8e94d276a56))
* **register:** auto-archive also does a log's first rotation (T3482) ([a3f3107](https://github.com/teamrig/teamrig/commit/a3f3107b8d3a214f06169f3fac6c66ed11a668ff))
* **release:** the release manifest starts from main's version, 0.489.0 (T3346) ([2837db1](https://github.com/teamrig/teamrig/commit/2837db19bdecbc9c050ceaa1b888e2d929d9f4fd))
* **setup:** the team pointer's git check runs through the kit's git runner (T4035) ([44ea00c](https://github.com/teamrig/teamrig/commit/44ea00cffdeb33b51ba24faf96685e8b584fdd58))
* **ship:** a catch-up sets the release manifest to main's plugin version again (T4298) ([fd7b89b](https://github.com/teamrig/teamrig/commit/fd7b89b79297d0b419f08ab58ad7f3ac9aa444bd))
* **ship:** a merge on the ci gate sets its host share aside for the checks' wait and the merge call (T3336) ([5d31161](https://github.com/teamrig/teamrig/commit/5d3116172a4593549594b8906ed66a368b1c7859))
* **ship:** a merge's catch-up push that loses the version race to a merge landing during its gate catches up again (T4131) ([cae099f](https://github.com/teamrig/teamrig/commit/cae099f3bed69a5e85ae005d13b354f2680e2f94))
* **ship:** a raise that stamps a migration's firstRelease is the raise, taken back for review (T4171) ([0a02199](https://github.com/teamrig/teamrig/commit/0a021998673ee89913100550b72e9fba078fe4a6))
* **ship:** a run without --merge leaves the version raise and the dist out of the head it is approved on (T3346) ([a1db437](https://github.com/teamrig/teamrig/commit/a1db43716899cb0cf6dff8ee0873792d91869cec))
* **ship:** a ship tool check git did not answer is read again, never refused as a changed tool (T3368) ([367e972](https://github.com/teamrig/teamrig/commit/367e9729cd3390d193533ef8b9745724bfc2c57e))
* **ship:** a waiting ship runs from a moved checkout only when it moved forward from its pin (T3419) ([9cfdff2](https://github.com/teamrig/teamrig/commit/9cfdff2cb13d2b54a01bc3643cdbadbe5d585f70))
* **ship:** a waiting ship's code is read from its imports and the roots its tool names, at its pin and its head (T3419) ([19760c5](https://github.com/teamrig/teamrig/commit/19760c53401b52cb2a568ea67189a5d17bc60091))
* **ship:** an approval keeps through a migration's release stamp set again with the raise (T3419) ([12c08aa](https://github.com/teamrig/teamrig/commit/12c08aa8f80fcec67189fe81ac524bfe2dbb22bd)), closes [#1378](https://github.com/teamrig/teamrig/issues/1378)
* **ship:** an approval masks a migration's release stamp only at a version the change ships in (T3419) ([683090e](https://github.com/teamrig/teamrig/commit/683090e1b52aee9a6b9db1fd06f9edf781e71e7f)), closes [#1378](https://github.com/teamrig/teamrig/issues/1378)
* **ship:** an approval's fingerprint drops a diff's closing newline, so a raise sorting last keeps it (T4216) ([9505349](https://github.com/teamrig/teamrig/commit/950534985804bd531b2851263a952d8a0dc4c490))
* **ship:** the ship tool check reads a tool's code one import level per git run (T4035) ([78e5d16](https://github.com/teamrig/teamrig/commit/78e5d16308a648fd57b53812ad52a0240a500591))
* **spawn:** every program teamrig starts is hidden, so a background queue run opens no terminal tab (T3369) ([e03e570](https://github.com/teamrig/teamrig/commit/e03e570d51166600c488ec0fe0deeb0a213572a8))
* **test:** a bare teamrig test runs through the host queue, one spec file small and more heavy (T2323) ([7da07cf](https://github.com/teamrig/teamrig/commit/7da07cf29f07e61d9d29e6676bb424f4534e7deb)), closes [#877](https://github.com/teamrig/teamrig/issues/877)
* **test:** starter-watch specs run Git for Windows' own sh where PATH lacks one, so they no longer skip (T4103) ([7507d6a](https://github.com/teamrig/teamrig/commit/7507d6ac7a7705fd97dd8800dee8babb155f83b5))
* **wake:** a rush poke comes again only after something changed for the session (T3407) ([86b713b](https://github.com/teamrig/teamrig/commit/86b713bf7e27d56dce9248658d287a0e180a20fe))


### Performance Improvements

* **ci:** the coverage suite runs at most 10 test files at once (T4064) ([b829bcf](https://github.com/teamrig/teamrig/commit/b829bcf34ba11b7d99aa016f64ff66b729fe6f80))
* **ci:** the coverage suite runs half the host's cores at once (T4064) ([b11be41](https://github.com/teamrig/teamrig/commit/b11be4155cd337f3f0bff9233edaf626472a0f24))
* **ci:** the local gate runs its checks below normal priority (T4064) ([ab1b088](https://github.com/teamrig/teamrig/commit/ab1b08841f69912c7aa19a2244cdb64d8d97b02d))
* **queue:** a parked step writes only allow-listed variables to disk and runs with the dispatcher's env under them (T4093) ([7b45511](https://github.com/teamrig/teamrig/commit/7b455115e562097b894c7f716f5d57f1af7328a2))
* **queue:** queue --detach parks its step for one dispatcher, so a waiting step holds a file, not a node process (T4093) ([df83852](https://github.com/teamrig/teamrig/commit/df83852e9753604844edeb1abdb2f2112476a4aa))
* **queue:** the detached sweep starts a dispatcher for steps left parked with none running (T4093) ([9be3744](https://github.com/teamrig/teamrig/commit/9be3744bad502825f51ef5ffcb2332e31101a24b))
* **ship:** run the typecheck and the coverage suite once per ship, in the gate (T4064) ([7af92d9](https://github.com/teamrig/teamrig/commit/7af92d93239ef45e5de0fdcc340e034cba3ded01))
