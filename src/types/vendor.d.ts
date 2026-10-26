declare module '*/vendor/mediapipe/vision_bundle.mjs' {
  interface Category { categoryName: string; score: number }
  interface HandResult {
    landmarks: { x: number; y: number; z: number }[][];
    handedness?: Category[][];
    handednesses?: Category[][];
  }
  export class HandLandmarker {
    static createFromOptions(fileset: { wasmLoaderPath: string; wasmBinaryPath: string }, options: Record<string, unknown>): Promise<HandLandmarker>;
    detectForVideo(video: HTMLVideoElement, timestamp: number): HandResult;
    close(): void;
  }
}
declare module '*/vendor/mediapipe/vision_wasm_internal.mjs' {
  const ModuleFactory: (opts?: unknown) => Promise<unknown>;
  export default ModuleFactory;
}
