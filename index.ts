import axios, {AxiosResponse} from 'axios'; // Replaced HttpClient with axios
import SimpleCrypto from 'simple-crypto-js';

interface Options {
    baseUrl: string;
    fileSecret: string;
    readChunkSize?: number; // Optional
    onChunkComplete?: (chunkSize: number, bytesAccepted: number, bytesTotal: number) => void;
    onSuccess?: () => void;
}

interface Part {
    start: number,
    end: number;
}

export class HvbEncryptedUpload {
    private options: Options;
    private readonly file: File;
    private readonly readFileSize: number;
    private encryptor: SimpleCrypto;
    private readonly baseUrl: string;
    private readonly readChunkSize: number;
    private uploadUrl: string | null = null; // Changed to nullable
    private offset: number = 0;
    private estimatedEncryptedSize: number = 0;
    private realEncryptedSize: number = 0;
    private stopUpload: boolean = false;
    public err: Error | null = null;

    constructor(file: File, options: Options) {
        this.options = options;
        this.file = file;
        this.readFileSize = file.size;
        this.baseUrl = options.baseUrl;
        this.readChunkSize = options.readChunkSize || 1024 * 1024; // Default to 1MB chunks
        this.encryptor = new SimpleCrypto(options.fileSecret);
    }

    public stop() {
        this.stopUpload = true;
    }

    public async start(): Promise<void> {
        await this.initUpload();

        const parts: Part[] = this.splitSizeIntoParts();
        for (const part of parts) {
            if (this.stopUpload) {
                throw new Error("Upload aborted");
            }
            const fileSlice: Blob = await this.getFileSlice(part.start, part.end);
            this.realEncryptedSize += fileSlice.size;
            this.estimatedEncryptedSize = ((fileSlice.size / (part.end - part.start)) * this.readFileSize);
            await this.uploadChunk(fileSlice, this.offset, (part.end >= this.readFileSize));

            const bytesTotal: number = (part.end === this.readFileSize) ? this.offset : this.estimatedEncryptedSize;
            this.emitChunkComplete(part.end - part.start, this.offset, bytesTotal);
        }
        this.emitSuccess();
    }

    private async initUpload(): Promise<AxiosResponse> {
        const response: AxiosResponse = await axios.post(this.baseUrl, {}, {
            headers: {
                'Upload-Defer-Length': '1'
            }
        });
        const location = response.headers.location;
        if (!location) {
            this.err = new Error('Invalid or missing Location header');
        }
        this.uploadUrl = this.resolveUrl(this.baseUrl, location);
        return response;
    }

    private async uploadChunk(chunk: Blob, offset: number, isLastPart: boolean): Promise<AxiosResponse> {
        if (this.uploadUrl == null) {
            throw new Error("Upload URL is not specified");
        }

        try {
            const response: AxiosResponse = await axios.patch(this.uploadUrl, chunk, {
                headers: {
                    'Content-Type': 'application/octet-stream', // Removed offset+
                    'Upload-Offset': offset.toString(),
                    'Upload-Length': isLastPart ? this.realEncryptedSize.toString() : ''
                }
            });

            const newOffset: number = +response.headers['Upload-Offset'];
            if (!newOffset || newOffset === 0) {
                this.err = new Error('Server did not verify chunk upload to offset');
            }
            this.offset = newOffset;
            return response;

        } catch (error) {
            throw new Error(`Error on reading the upload response or response headers: ${error}`);
        }
    }

    private resolveUrl(baseUrl: string, location: string): string {
        return new URL(location, baseUrl).toString();
    }

    private async getFileSlice(start: number, end: number): Promise<Blob> {
        const value: Blob = this.file.slice(start, end);

        return await this.readFileAsBase64(value)
            .then(base64 => {
                const encrypted: string = this.encryptor.encrypt(base64);
                return new Blob([encrypted]);
            });
    }

    private async readFileAsBase64(blob: Blob): Promise<string> {
        return new Promise(resolve => {
            const reader: FileReader = new FileReader();
            reader.onerror = () => this.err = reader.error;

            reader.onload = function (event: ProgressEvent<FileReader>): void {
                if (event.target == null || typeof event.target.result !== 'string') {
                    throw new Error("Error during file reading process");
                }
                resolve(event.target.result);

            };
            reader.readAsDataURL(blob);
        });
    }

    private splitSizeIntoParts(): Part[] {
        const partCount: number = Math.ceil(this.readFileSize / this.readChunkSize);
        const parts: Part[] = [];

        let start: number = 0;
        let end: number = this.readChunkSize;
        for (let i: number = 0; i < partCount; i++) {

            parts.push({
                start: start,
                end: end,
            });

            start += this.readChunkSize;
            end = start + this.readChunkSize;
        }
        return parts;
    }

    private emitChunkComplete(chunkSize: number, bytesAccepted: number, bytesTotal: number): void {
        if (typeof this.options.onChunkComplete === 'function') {
            this.options.onChunkComplete(chunkSize, bytesAccepted, bytesTotal);
        }
    }

    private emitSuccess(): void {
        if (typeof this.options.onSuccess === 'function') {
            this.options.onSuccess();
        }
    }
}
