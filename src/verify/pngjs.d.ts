// pngjs ships no declarations and this repository does not depend on @types/pngjs; the oracle uses
// only the synchronous reader and writer.
declare module "pngjs" {
  export class PNG {
    constructor(options?: { width: number; height: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buffer: Buffer | Uint8Array): PNG;
      write(png: PNG): Buffer;
    };
  }
}
