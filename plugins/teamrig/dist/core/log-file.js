/** A log that is one file, appended to without a lock. */
export class PlainLogFile {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    read() {
        return this.files.read(this.path);
    }
    append(text) {
        return this.files.append(this.path, text);
    }
}
