# Vendored MediaPipe Hand Landmarker (Apache-2.0)

Used by the Silent Signal camera section (sign language). All processing runs in the browser; no frame leaves the device.

| File | Source | SHA-256 |
|---|---|---|
| vision_bundle.mjs | github.com/whatisor/mediapipe-tasks-vision @ 79df5da (prebuilt `@mediapipe/tasks-vision` from a MediaPipe fork) | dfad1a2a57e0cbb291ec33caa827bdd37ea3b39cf55386a9a91694f10cc92c95 |
| vision_wasm_internal.wasm | same commit, `wasm/` | 0a6d05ba5374a5757b3f4ddee19ce958868df48fce3e1a69400cec606e7743b0 |
| vision_wasm_internal.mjs | same commit, `wasm/vision_wasm_internal.js`, CommonJS/AMD footer replaced by `export default ModuleFactory;` | 1ef23bad75303680d0b07f0c1f72559a2f51fe9b6e124311cc15e90bd81d80d9 |
| hand_landmarker.task | identical copies in github.com/Moayadai/Sign-Language-Recognition @ c39eea4 (`models/hand_landmarker.task`), Hezki-png/Sign-Language and hardik5ingh/VoxHand (same Git blob 0d53faf); size matches Google's float16 v1 Hand Landmarker | fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1 |

Why these sources: this build environment cannot reach npm, jsDelivr or Google storage, only public Git repositories.
For production, replace them with the official `@mediapipe/tasks-vision` npm package and the official model from
`storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`, pinned by hash.
