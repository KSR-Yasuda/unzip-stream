var fs = require('fs');
var path = require('path');
var util = require('util');
var mkdirp = require('mkdirp');
var Transform = require('stream').Transform;
var UnzipStream = require('./unzip-stream');

function Extract (opts) {
    if (!(this instanceof Extract))
    return new Extract(opts);

    Transform.call(this);

    this.opts = opts || {};
    this.unzipStream = new UnzipStream(this.opts);
    this.unfinishedEntries = 0;
    this.afterFlushWait = false;
    this.createdDirectories = {};
    this.queuedProps = new Map();

    var self = this;
    this.unzipStream.on('entry', this._processEntry.bind(this));
    this.unzipStream.on('prop', this._processProp.bind(this));
    this.unzipStream.on('error', function(error) {
        self.emit('error', error);
    });
}

util.inherits(Extract, Transform);

Extract.prototype._transform = function (chunk, encoding, cb) {
    this.unzipStream.write(chunk, encoding, cb);
}

Extract.prototype._flush = function (cb) {
    var self = this;

    var allDone = function() {
        process.nextTick(function() { self.emit('close'); });
        cb();
    }

    this.unzipStream.end(function() {
        if (self.unfinishedEntries > 0) {
            self.afterFlushWait = true;
            return self.on('await-finished', allDone);
        }
        allDone();
    });
}

Extract.prototype._processEntry = function (entry) {
    var self = this;
    var destPath = path.join(this.opts.path, entry.path);
    var directory = entry.isDirectory ? destPath : path.dirname(destPath);

    this.unfinishedEntries++;

    var writeFileFn = function() {
        var pipedStream = fs.createWriteStream(destPath);

        pipedStream.on('close', function() {
            if (self.queuedProps.has(entry.path)) {
                self._processProp(self.queuedProps.get(entry.path));
                self.queuedProps.delete(entry.path);
            }

            self.unfinishedEntries--;
            self._notifyAwaiter();
        });
        pipedStream.on('error', function (error) {
            self.emit('error', error);
        });
        entry.pipe(pipedStream);
    }

    if (this.createdDirectories[directory] || directory === '.') {
        return writeFileFn();
    }

    // FIXME: calls to mkdirp can still be duplicated
    mkdirp(directory, function(err) {
        if (err) return self.emit('error', err);

        self.createdDirectories[directory] = true;

        if (entry.isDirectory) {
            self.unfinishedEntries--;
            self._notifyAwaiter();
            return;
        }

        writeFileFn();
    });
}

Extract.prototype._processProp = function (props) {
    var entryPath = props.path && path.join(this.opts.path, props.path);

    if (this.opts.debug) {
        console.log("process props", JSON.stringify(
            Object.assign({
                baseDir: this.opts.path,
                exists: entryPath && fs.existsSync(entryPath)
            }, props),
            null, 2
        ));
    }

    if (!entryPath) {
        return;
    }
    if (!fs.existsSync(entryPath)) {
        // Postpone until entry creation.
        // `prop` event gets into this case.
        this.queuedProps.set(props.path, props);
        return;
    }

    if (props.mtime != null) {
        fs.utimes(entryPath, props.mtime, props.mtime, (err) => {
            if (!err) {
                return;
            }

            console.error(`utimes() failed: file = ${entryPath}`);
            // FIXME: Now ignore the error.
        });
    }

    if (props.uid != null || props.gid != null) {
        fs.chown(entryPath, props.uid, props.gid, (err) => {
            if (!err) {
                return;
            }

            console.error(`chown() failed: file = ${entryPath}`);
            // FIXME: Now ignore the error.
        });
    }

    if(props.unixAttrs != null) {
        fs.chmod(entryPath, props.unixAttrs, (err) => {
            if (!err) {
                return;
            }

            console.error(`chmod() failed: file = ${entryPath}`);
            // FIXME: Now ignore the error.
        });
    }
}

Extract.prototype._notifyAwaiter = function() {
    if (this.afterFlushWait && this.unfinishedEntries === 0) {
        this.emit('await-finished');
        this.afterFlushWait = false;
    }
}

module.exports = Extract;
