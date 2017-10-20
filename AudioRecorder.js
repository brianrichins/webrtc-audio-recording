function AudioRecorder(configuration, onChange) {
    let config = {
        bufferSize : 4096,
        sampleRate : 44100,
        numChannels:  2 // 1 or 2
    };
    if (configuration) {
        Object.assign(config, configuration);
    }

    let AudioPersist = window.AudioPersist = {},  //create global ref to prevent garbage collection of AudioContext
        analyzer = {
            mediaStream: null,
            audioInput: null,
            jsAudioNode: null,
            leftChannel: [],
            rightChannel: [],
            recordingLength: 0
        },
        state = {  
            recording: false,
            audioStarted: false
        };
    Object.defineProperty(state, 'isRecording', {
        get: function () { return this.recording; },
        set: function (y) { this.recording = y; onChange && onChange(this.recording); }
    });

    //TODO: add public methods/callbacks for monitoring recording state (bool) and analyzer data (volume)
    let output = this.output = {};  //public access


    this.start = function () {
        setup();

        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(onMicCaptured)
            .catch(onMicCaptureError);
    };

    function setup() {
        AudioPersist.ctx = new AudioContext();

        if (AudioPersist.ctx.createJavaScriptNode) {
            analyzer.jsAudioNode = AudioPersist.ctx.createJavaScriptNode(config.bufferSize, config.numChannels, config.numChannels);
        } else if (AudioPersist.ctx.createScriptProcessor) {
            analyzer.jsAudioNode = AudioPersist.ctx.createScriptProcessor(config.bufferSize, config.numChannels, config.numChannels);
        } else {
            throw 'WebAudio API has no support on this browser.';
        }

        analyzer.jsAudioNode.connect(AudioPersist.ctx.destination);
    }
    function teardown() {
        analyzer.leftChannel = analyzer.rightChannel = [];
        analyzer.recordingLength = 0;
        //TODO: strip out unused refs to simplify teardown
        analyzer.jsAudioNode.disconnect();
        analyzer.mediaStream.getAudioTracks().forEach(t => t.stop());
        analyzer.jsAudioNode = analyzer.mediaStream = analyzer.audioInput = analyzer.audioTrack = null;

        //TODO: clear config (and nested configs) channel arrays (?)

        AudioPersist.ctx.close();
        delete AudioPersist.ctx;
    }

    function onMicCaptured(micStream) {
        analyzer.mediaStream = micStream;

        analyzer.audioInput = AudioPersist.ctx.createMediaStreamSource(micStream);
        analyzer.audioInput.connect(analyzer.jsAudioNode);

        analyzer.jsAudioNode.onaudioprocess = onAudioProcess;

        state.isRecording = true;
    }
    function onMicCaptureError() {
        console.log("There was an error accessing the microphone. You may need to allow the browser access");
        //TODO: provide callback for UI feedback
    }
   

    function onAudioProcess(e) {
        if (isMediaStreamActive() === false) {
            if (!config.disableLogs) {  //TODO: call out config options in declaration
                console.log('MediaStream seems stopped.');
            }
        }

        if (!state.isRecording) {
            return;
        }

        if (!state.audioStarted) {  //TODO: call out config options in declaration
            state.audioStarted = true;
            if (config.onAudioProcessStarted) {
                config.onAudioProcessStarted();
            }

            if (config.initCallback) {   //TODO: call out config options in declaration
                config.initCallback();
            }
        }


        // clone the samples
        var left = e.inputBuffer.getChannelData(0);
        analyzer.leftChannel.push(new Float32Array(left));

        if (config.numChannels === 2) {
            var right = e.inputBuffer.getChannelData(1);
            analyzer.rightChannel.push(new Float32Array(right));
        }

        analyzer.recordingLength += config.bufferSize;
    }

    function isMediaStreamActive() {
        if (config.checkForInactiveTracks) {  //TODO: call out in config options
            if ('active' in analyzer.mediaStream) {
                return analyzer.mediaStream.active;
            } else if ('ended' in analyzer.mediaStream) { // deprecated/removed - TODO: remove
                return !analyzer.mediaStream.ended;
            }
        }
        return true;
    }

    function mergeLeftRightBuffers(buffData, onMergeComplete) {

        function mergeAudioBuffers(msgData, onMsgHandled) {
            var numChannels = msgData.numChannels;
            var sampleRate = msgData.sampleRate;
            var leftBuffer = msgData.leftBuffers.slice(0);
            var rightBuffer = msgData.rightBuffers.slice(0);

            // merge buffer arrays
            leftBuffer = flattenBuffer(leftBuffer);
            if (numChannels === 2) {
                rightBuffer = flattenBuffer(rightBuffer);
            }

            function flattenBuffer(channelBuffer) {
                var result = new Float64Array(channelBuffer.length * channelBuffer[0].length);

                for (let i = 0, offset = 0; i < channelBuffer.length; i++) {
                    var buffer = channelBuffer[i];
                    result.set(buffer, offset);
                    offset += buffer.length;
                }

                return result;
            }


            // interleave channels together (if needed)
            let interleaved = (numChannels === 1) ? leftBuffer : interleave(leftBuffer, rightBuffer),
                interleavedLength = interleaved.length;

            function interleave(leftChan, rightChan) {
                var length = leftChan.length + rightChan.length;

                var result = new Float64Array(length);

                var inputIndex = 0;

                for (var index = 0; index < length;) {
                    result[index++] = leftChan[inputIndex];
                    result[index++] = rightChan[inputIndex];
                    inputIndex++;
                }
                return result;
            }


            // create wav file
            function writeUTFBytes(view, offset, string) {
                for (let i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            }

            var resultingBufferLength = 44 + interleavedLength * 2;
            var buffer = new ArrayBuffer(resultingBufferLength);
            var view = new DataView(buffer);

            writeUTFBytes(view, 0, 'RIFF'); // RIFF chunk descriptor/identifier
            view.setUint32(4, 44 + interleavedLength * 2, true); // RIFF chunk length
            writeUTFBytes(view, 8, 'WAVE'); // RIFF type

            // format chunk identifier
            writeUTFBytes(view, 12, 'fmt ');    // FMT sub-chunk
            view.setUint32(16, 16, true);   // format chunk length
            view.setUint16(20, 1, true);    // sample format (raw)

            view.setUint16(22, numChannels, true);  // stereo (2 channels)
            view.setUint32(24, msgData.sampleRate, true);    // sample rate
            view.setUint32(28, msgData.sampleRate * 2, true);    // byte rate (sample rate * block align)
            view.setUint16(32, numChannels * 2, true);  // block align (channel count * bytes per sample)
            view.setUint16(34, 16, true);   // bits per sample

            // data sub-chunk
            writeUTFBytes(view, 36, 'data');    // data chunk identifier
            view.setUint32(40, interleavedLength * 2, true);    // data chunk length

            // write the PCM samples
            var index = 44;
            var volume = 1;
            for (let i = 0; i < interleavedLength; i++) {
                view.setInt16(index, interleaved[i] * (0x7FFF * volume), true);
                index += 2;
            }

            if (onMsgHandled) {
                return onMsgHandled({
                    buffer: buffer,
                    view: view
                });
            }

            postMessage({
                buffer: buffer,
                view: view
            });
        }

        var webWorker = processInWebWorker(mergeAudioBuffers);
        webWorker.onmessage = function (event) {
            onMergeComplete(event.data.buffer, event.data.view);

            // release memory
            URL.revokeObjectURL(webWorker.workerURL);
            webWorker.terminate();
        };
        webWorker.postMessage(buffData);
    }

    function processInWebWorker(_function) {
        var workerURL = URL.createObjectURL(new Blob([_function.toString(),
            ';this.onmessage =  function (e) {' + _function.name + '(e.data);}'
            ], {
                type: 'application/javascript'
            }));

        var worker = new Worker(workerURL);
        worker.workerURL = workerURL;
        return worker;
    }


    this.stop = function (handleBlobUrl) {
        stopRecording(handleBlobUrl);
    };
    function stopRecording(onOutputReady) {
        state.isRecording = state.audioStarted = false;

        // to make sure onaudioprocess stops firing
        analyzer.audioInput.disconnect();
        analyzer.jsAudioNode.disconnect();

        let bufferData = {
            numChannels: config.numChannels,
            sampleRate: config.sampleRate,
            leftBuffers: analyzer.leftChannel,
            rightBuffers: config.numChannels === 1 ? [] : analyzer.rightChannel
        };
        mergeLeftRightBuffers(bufferData, writeWavToOutput);

        function writeWavToOutput(buffer, view) {
            output.wavBlob = new Blob([view], {
                type: 'audio/wav'
            });

            output.buffer = new ArrayBuffer(view.buffer.byteLength);
            output.view = view;
            output.sampleRate = config.sampleRate;
            output.bufferSize = config.bufferSize;
            output.length = analyzer.recordingLength;

            onOutputReady && onOutputReady(output.wavBlob);

            teardown();
        }
    }
};
