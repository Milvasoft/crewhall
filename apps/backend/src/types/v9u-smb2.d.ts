/**
 * v9u-smb2 (MIT; SMB2 with NTLMv2): only what external storage mounts use. Every method
 * returns a promise when called without a callback.
 */
declare module 'v9u-smb2' {
  interface SmbStats {
    name: string;
    mtime: Date;
    birthtime: Date;
    isDirectory(): boolean;
  }
  interface SmbOptions {
    share: string;
    domain: string;
    username: string;
    password: string;
    port?: number;
    autoCloseTimeout?: number;
  }
  class SMB2 {
    constructor(options: SmbOptions);
    readdir(path: string, options: { stats: true }): Promise<SmbStats[]>;
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: Buffer): Promise<void>;
    mkdir(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    getSize(path: string): Promise<number>;
    disconnect(): void;
  }
  export = SMB2;
}
