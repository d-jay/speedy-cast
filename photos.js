/**
 * The receiver's JavaScript implemenation.
 */

var FAST_PHOTOS_IMAGE_LOAD_TIMEOUT_SECONDS = 30;
var FAST_PHOTOS_SPLASH_TIMER_SECONDS = 2;
var SESSION_CLOSE_DELAY_SECONDS = 1;
var FAST_PHOTOS_PROTOCOL = 'urn:x-cast:com.speedy-cast.fastphotos';
// Change this to true for debugging.
var FAST_PHOTOS_SHOW_LOGS = false;
var FAST_PHOTOS_PROTOCOL_VERSION = 1;

var KEY_PAYLOAD = 'payload';
var KEY_WINDOW_WIDTH = 'windowWidth';
var KEY_WINDOW_HEIGHT = 'windowHeight';
var KEY_CUSTOM_DATA_STREAMS = 'streams';

// CSI signals and variables.
var CSI_ACTION_IMG = 'photos_cast_img';
var CSI_ACTION_PRECACHE = 'photos_cast_precache';
var CSI_ACTION_PHOTO = 'photos_cast_photo';
var CSI_ACTION_SESSION = 'photos_cast_session';
var CSI_VARIABLE_IMG_REQUEST = 'imgrq';
var CSI_VARIABLE_IMG_LOADED = 'imgl';
var CSI_VARIABLE_IMG_FAILED = 'imgf';
var CSI_VARIABLE_SESSION_START = 'caststart';
var CSI_VARIABLE_SESSION_LENGTH = 'castlength';
var CSI_VARIABLE_NUM_PHOTOS = 'nphotos';
var CSI_VARIABLE_NUM_VIDEOS = 'nvideos';

// Time in milliseconds we wait for a high quality stream to load before we
// give up and load a lower quality one.
var DEFAULT_STREAM_LOADING_TIMEOUT = 7 * 1000;

// Time in milliseconds from last video quality change until we reset the
// quality preference and try the highest video quality again.
var STREAM_QUALITY_RESET_TIMEOUT = 5 * 60 * 1000;

// Time we wait until spinner goes away after playback starts
var VIDEO_HIDE_SPINNER_DELAY = 0.5;

var cast = window.cast || {};

function initReceiver() {
  if (!FAST_PHOTOS_SHOW_LOGS) {
    cast.receiver.logger.setLevelValue(cast.receiver.LoggerLevel.NONE);
  }
  var castReceiverManager = cast.receiver.CastReceiverManager.getInstance();

  new cast.Photos(castReceiverManager);
  var mediaManager = new cast.receiver.MediaManager($('#video-player')[0]);
  createRampHandler(mediaManager);

  castReceiverManager.start();
}

function createRampHandler(mediaManager) {
  var handler = mediaManager;

  // Specifies what stream quality we should play.
  // 0 means we should play the default (highest quality) stream we receive.
  // Higher numbers mean we'll be playing streams of less quality.
  handler.streamQualityLevel = 0;

  handler.lastStreamQualityChangeTime = new Date().getTime();

  handler.originalOnLoad = handler.onLoad;
  handler.originalOnLoadMetadataError = handler.onLoadMetadataError;
  handler.originalOnEnded = handler.onEnded;

  handler.getStreams = function() {
    var streams = handler.customData[KEY_CUSTOM_DATA_STREAMS];
    if (!streams || streams.length == 0) {
      return null;
    }
    return streams;
  };

  handler.getStreamUrl = function() {
    var streams = handler.getStreams();

    if (handler.streamQualityLevel < streams.length) {
      return streams[handler.streamQualityLevel];
    } else {
      return streams[streams.length - 1];
    }
  };

  handler.isUsingLowestQualityStream = function() {
    var streams = handler.getStreams();

    return handler.streamQualityLevel >= streams.length - 1;
  };

  handler.degradeStreamTimeout = function() {
    if (!isVideoActive()) {
      return;
    }

    handler.streamQualityLevel += 1;
    handler.lastStreamQualityChangeTime = new Date().getTime();

    loadVideo(handler.getStreamUrl());
  };

  handler.clearAndSetDegradeStreamTimeout = function() {
    handler.clearDegradeStreamTimeout();

    // The timeout will degrade the stream if it hasn't been
    // loaded within a certain time.
    handler.degradeStreamTimeoutId = window.setTimeout(
      handler.degradeStreamTimeout,
      DEFAULT_STREAM_LOADING_TIMEOUT);
  };

  handler.clearDegradeStreamTimeout = function() {
    if (handler.degradeStreamTimeoutId !== undefined) {
      window.clearTimeout(handler.degradeStreamTimeoutId);
    }
  };

  handler.capStreamQualityLevel = function() {
    var streams = handler.getStreams();
    if (handler.streamQualityLevel >= streams.length) {
      handler.streamQualityLevel = streams.length - 1;
    }
  };

  handler.checkAndResetStreamQuality = function() {
    var currentTime = new Date().getTime();
    if (currentTime - handler.lastStreamQualityChangeTime >
      STREAM_QUALITY_RESET_TIMEOUT) {
      handler.streamQualityLevel = 0;
      handler.lastStreamQualityChangeTime = currentTime;
    }
  };

  handler.onLoadMetadataError = function(message) {
    handler.originalOnLoadMetadataError(message);
    handler.clearDegradeStreamTimeout();
  };

  handler.onLoad = function(event) {
    displaySpinner(true);
    handler.lastVideoTime = 0.0;

    handler.customData = event.data.customData;

    if (handler.getStreams() == null) {
      logError('streams cannot be empty.');
      return;
    }

    // Cap the stream quality since we might have received fewer streams than
    // last time.
    handler.capStreamQualityLevel();

    // Reset stream quality if some time has passed since last quality change.
    handler.checkAndResetStreamQuality();

    // Modify event so the correct stream is loaded. This is a slight hack
    // since it depends on the structure of event, but it lets us reuse the
    // originalOnLoad.
    event['data']['media']['contentId'] = handler.getStreamUrl();
    handler.originalOnLoad.call(handler, event);

    if (!handler.isUsingLowestQualityStream()) {
      handler.clearAndSetDegradeStreamTimeout();
    }
    cast.Photos.numVideosShown++;
  };

  // onEnded is called after the video has finished playing. The
  // default behavior is to reset the video element and clear the src attribute,
  // causing the screen to go blank.
  // When this happens we switch to the video thumbnail.
  handler.onEnded = function() {
    handler.originalOnEnded();
    // Display the video thumbnail.
    displayPhoto();
  };

  handler.addEventListener(
    cast.receiver.MediaManager.EventType.SEEK, function(event) {
      handler.lastVideoTime = event.data['currentTime'];
      displaySpinner(true);
  });

  handler.addEventListener(
    cast.receiver.MediaManager.EventType.PAUSE, function(event) {
      displaySpinner(false);
  });

  // We are not listening to the 'playing' event since that event can be seen
  // several seconds before the first frame is visible. Instead we listen to
  // playback timeupdate events and hide the spinner as soon as we've seen
  // progress in playback.
  var videoElement = $('#video-player')[0];
  videoElement.addEventListener('timeupdate', function(event) {
    if (videoElement.currentTime - handler.lastVideoTime >
        VIDEO_HIDE_SPINNER_DELAY) {
      handler.clearDegradeStreamTimeout();
      displayVideo();
    }
  }, false);

  return handler;
}

function isVideoActive() {
  return $('#video-player').is(':visible');
}

function displaySplash() {
  $('#splash').show();
  $('#image-canvas').hide();
  $('#video-player').hide();
  displaySpinner(false);
}

function displayVideo() {
  $('#splash').hide();
  $('#image-canvas').hide();
  $('#video-player').show();
  displaySpinner(false);
}

function displayPhoto() {
  $('#splash').hide();
  $('#image-canvas').show();
  $('#video-player').hide();
  displaySpinner(false);
}

function displaySpinner(spinnerVisible) {
  if (spinnerVisible) {
    $('#splash').hide();
  }
  $('#activity').toggle(spinnerVisible);
}

function pauseVideo() {
  $('#video-player')[0].pause();
}

function loadVideo(streamUrl) {
  var videoElement = $('#video-player')[0];
  videoElement.src = streamUrl;
  videoElement.load();
}

function logError(message) {
  if (FAST_PHOTOS_SHOW_LOGS) {
    console.log('ERROR: ' + message);
  }
}

(function() {
  'use_strict';

  // The sender id of the currently casting client.
  Photos.activeSenderId = -1;

  // An auto-incrementing sender id counter.
  Photos.senderIdCounter = 0;

  // Stack of image jobs.
  Photos.imageJobStack = [];

  // Timer for switching the spinner to splash screen. Used when the receiver
  // app starts up.
  Photos.splashTimer = null;

  // The image job timer.
  Photos.imageJobTimer = null;

  // Preoload image job stack
  Photos.preloadImageJobStack = [];

  // The current image source.
  Photos.imageSource = '';

  // The current image source to be displayed.
  Photos.imageSourceForDisplay = '';

  // Map from connected devices to session tokens.
  Photos.sessionTokens = {};

  Photos.numPhotosShown = 0;
  Photos.numVideosShown = 0;

//  Photos.sessionTiming = null;

  /**
   * Creates a new image job object needed for the job stack
   *
   * @param {number} senderId this job refers to
   * @param {!Object} asset asset to be precached
   * @param {boolean} preload whether this is a preload job or not
   * @return {!Object} an image job object that can be used on job stack
   * @constructor
   */
  function ImageJob(senderId, asset, preload) {
    this.senderId = senderId;
    this.asset = asset;
    this.preload = preload;
    this.result = null;

//    this.timing = new window.jstiming.Timer();
//    this.timing.name = CSI_ACTION_IMG + ',' +
//        (preload ? CSI_ACTION_PRECACHE : CSI_ACTION_PHOTO);
  }

  ImageJob.prototype = {
    markRequestStart: function() {
      // Time between receiving the request from sender and actually sending the
      // request to fife.
//      this.timing.tick(CSI_VARIABLE_IMG_REQUEST);
    },

    markSuccess: function() {
      this.result = 'success';
//      this.timing.tick(CSI_VARIABLE_IMG_LOADED, CSI_VARIABLE_IMG_REQUEST);
//      window.jstiming.report(this.timing);
//      this.timing = null;
    },

    markFailure: function() {
      this.result = 'HTTPRequestError';
//      this.timing.tick(CSI_VARIABLE_IMG_FAILED, CSI_VARIABLE_IMG_REQUEST);
//      window.jstiming.report(this.timing);
//      this.timing = null;
    }
  };

  function Photos(castReceiverManager) {
    this.castReceiverManager = castReceiverManager;

    this.castMessageBus =
      castReceiverManager.getCastMessageBus(FAST_PHOTOS_PROTOCOL,
        cast.receiver.CastMessageBus.MessageType.JSON);

    this.castReceiverManager.addEventListener(
      cast.receiver.CastReceiverManager.EventType.SENDER_CONNECTED,
      this.onSenderConnected.bind(this));

    this.castReceiverManager.addEventListener(
      cast.receiver.CastReceiverManager.EventType.SENDER_DISCONNECTED,
      this.onSenderDisconnected.bind(this));

    this.castMessageBus.addEventListener(
      cast.receiver.CastMessageBus.EventType.MESSAGE,
      this.onMessage.bind(this));

    Photos.splashTimer = window.setTimeout(function() {
      displaySplash();
    }, FAST_PHOTOS_SPLASH_TIMER_SECONDS * 1000);
  }

  Photos.prototype = {
    /**
     * Handle a sender connected event.
     */
    onSenderConnected: function(event) {
      // Assign an id to this sender.
      event.target.senderId = Photos.senderIdCounter;
      Photos.senderIdCounter += 1;
//      Photos.sessionTiming = new window.jstiming.Timer();
//      Photos.sessionTiming.name = CSI_ACTION_SESSION;
//      Photos.sessionTiming.tick(CSI_VARIABLE_SESSION_START);
    },

    /**
     * Handle a sender disconnected event.
     */
    onSenderDisconnected: function(event) {
//      if (Photos.sessionTiming) {
//        Photos.sessionTiming.tick(CSI_VARIABLE_SESSION_LENGTH);
//        var artificialTick = function(name, value) {
//          var dummyTick = '_' + name;
//          Photos.sessionTiming.tick(dummyTick, undefined, 0);
//          Photos.sessionTiming.tick(name, dummyTick, value);
//        };
//        artificialTick(CSI_VARIABLE_NUM_PHOTOS, Photos.numPhotosShown);
//        artificialTick(CSI_VARIABLE_NUM_VIDEOS, Photos.numVideosShown);
//        window.jstiming.report(Photos.sessionTiming);
//        Photos.sessionTiming = null;
//      }
      if (this.castReceiverManager.getSenders().length == 0) {
        window.setTimeout(function() {
          // Allowing CSI beacon to get through.
          window.close();
        }, SESSION_CLOSE_DELAY_SECONDS * 1000);
      }
    },

    /**
     * Handle an incoming message from the stream.
     */
    onMessage: function(event) {
      var messageName = event.data.name;

      // Log the new messageName if available.
      if (FAST_PHOTOS_SHOW_LOGS && messageName) {
        console.log('Received ' + messageName + ' msg');
      }

      if (messageName == 'newSession') {
        var result = '';
        var sessionToken = event.data.sessionToken;

        if (sessionToken) {
          // Store the session token for this client.
          Photos.sessionTokens[event.senderId] = sessionToken;
        }

        if (!window.innerHeight || !window.innerWidth) {
          logError('Invalid window size: window.innerHeight=' +
            window.innerHeight + ', window.innerWidth=' + window.innerWidth);
        }

        var payload = {};
        payload['result'] = 'success';
        payload[KEY_WINDOW_HEIGHT] = window.innerHeight;
        payload[KEY_WINDOW_WIDTH] = window.innerWidth;
        var response = this.makeResponse(messageName, payload);

        this.castMessageBus.send(event.senderId, response);
      } else if (messageName == 'invalidateSession') {
        if (event.target.senderId == Photos.activeSenderId) {
          // Stop the playing video (if any)
          pauseVideo();

          // Show the splash screen if this is the actively casting client.
          displaySplash();
        }

        // Clear the token for this client.
        Photos.sessionTokens[event.target.senderId] = '';
      } else if (messageName == 'newAsset') {
        window.clearTimeout(Photos.splashTimer);
        var error = '';
        var payload = event.data.payload;

        if (payload.asset.location == 'remote') {
          if (payload.asset.type == 'image') {
            if (this.checkValidUrl(payload.asset.url)) {
              // Create and insert a new image job.
              Photos.imageJobStack.push(new ImageJob(
                  event.senderId, payload.asset, false));
              Photos.imageSourceForDisplay = payload.asset.url;
              pauseVideo();
              displayPhoto();
              this.loadImage();
            } else {
              error = 'invalidUrl';
            }
          } else {
            error = 'invalidAssetTypeError';
          }
        } else {
          error = 'invalidAssetLocationError';
        }

        // If there is an error, respond with error message to the client.
        if (error) {
          var response = this.makeResponse(messageName,
            {
              'result': error,
              'asset': payload.asset
            }
          );
          this.castMessageBus.send(event.senderId, response);
          return;
        }

        this.precacheAssets(payload, event.senderId);
      } else if (messageName == 'precacheAssets') {
        var payload = event.data.payload;
        if (!this.precacheAssets(payload, event.senderId)) {
          this.log('No urls to precache');
        }
      }
    },

    /**
     * Looks for the precache field in payload, and tries to precache
     * any assets in that array.
     */
    precacheAssets: function(payload, senderId) {
      if (payload.precache && payload.precache.length > 0) {
        this.log('We have a precache!');
        // For now we are only using one precache image
        var asset = payload.precache[0];
        if (asset.location == 'remote' && asset.type == 'image') {
          if (this.checkValidUrl(asset.url)) {
            Photos.preloadImageJobStack.push(new ImageJob(
                senderId, payload.precache[0], true));
            this.preloadImage();
          }
        }
        return true;
      }
      return false;
    },

    /**
     * Dequeues a source URI from the image stack and loads it into the
     * browser's cache.
     */
    loadImage: function() {
      var caller = this;
      var imageJob = Photos.imageJobStack.pop();

      if (imageJob) {
        // Show the activity spinner.
        if (!imageJob.preload &&
            (imageJob.asset.url == Photos.imageSourceForDisplay)) {
          displaySpinner(true);
        }

        // If there's a current job, check to see whether it has a different
        // source URI. If so, abort the current job. Otherwise, just push this
        // job back onto the stack.
        if (Photos.imageSource) {
          if (Photos.imageSource == imageJob.asset.url) {
            Photos.imageJobStack.push(imageJob);
            return;
          }

          window.stop();
          Photos.imageSource = '';
        }

        // Set a timeout for the image load.
        window.clearTimeout(Photos.imageJobTimer);
        var savedImageJob = imageJob;
        Photos.imageJobTimer = window.setTimeout(function() {
          window.stop();
          Photos.imageSource = '';
          displaySpinner(true);

          // Send a timeout error to the client.
          this.castReceiverManager.getSenders().forEach(
            function(senderId) {
              if (senderId == savedImageJob.senderId) {
                var response = this.makeResponse('newAsset',
                  {
                    'asset': imageJob.asset,
                    'result': 'HTTPRequestTimeoutError'
                  }
                );

                this.castMessageBus.send(senderId, response);
              }
            }
          );
        }, FAST_PHOTOS_IMAGE_LOAD_TIMEOUT_SECONDS * 1000);

        // Log the start of the image job.
        if (FAST_PHOTOS_SHOW_LOGS) {
          console.log('Starting loadImage job:\n' + JSON.stringify(imageJob));
        }

        /** @this {!Element} */
        var handleLoadLoad = function() {
          this.removeEventListener('load', handleLoadLoad);
          this.removeEventListener('error', handleLoadError);
          imageJob.markSuccess();
          this.id = '';
          caller.onImageJobFinished(imageJob, this);
        };

        /** @this {!Element} */
        var handleLoadError = function() {
          this.removeEventListener('load', handleLoadLoad);
          this.removeEventListener('error', handleLoadError);
          imageJob.markFailure();
          caller.onImageJobFinished(imageJob);
        };

        // Begin loading the image.
        Photos.imageSource = imageJob.asset.url;
        var newImage = document.getElementById('image-prototype').
            cloneNode(true);
        newImage.addEventListener('load', handleLoadLoad);
        newImage.addEventListener('error', handleLoadError);
        imageJob.markRequestStart();
        newImage.src = imageJob.asset.url;
      }
    },

    /**
     * Preloads images from the preload stack
     */
    preloadImage: function() {
      var imageJob = Photos.preloadImageJobStack.pop();
      if (imageJob) {
        // Log the start of the image job.
        this.log('Starting preloadImage job:\n' + JSON.stringify(imageJob));
        var _this = this;

        /** @this {!Element} */
        var handlePreloadLoad = function() {
          _this.log('successfully precached');
          this.removeEventListener('load', handlePreloadLoad);
          this.removeEventListener('error', handlePreloadError);
          imageJob.markSuccess();
          _this.preloadImage();
        };

        /** @this {!Element} */
        var handlePreloadError = function() {
          _this.log('failed precaching');
          this.removeEventListener('load', handlePreloadLoad);
          this.removeEventListener('error', handlePreloadError);
          imageJob.markFailure();
          _this.preloadImage();
        };

        // Begin preloading the image.
        var newImage = document.getElementById('image-prototype').
            cloneNode(true);
        newImage.addEventListener('load', handlePreloadLoad);
        newImage.addEventListener('error', handlePreloadError);
        imageJob.markRequestStart();
        newImage.src = imageJob.asset.url;
      }
    },

    /**
     * Called when an image job finishes. Clears the image job timer and temp
     * variables and starts the next image job if available.
     *
     * @param {!Object} imageJob The current image job.
     * @param {Object=} opt_image The image job's HTML element object is
     * optional.
     */
    onImageJobFinished: function(imageJob, opt_image) {
      window.clearTimeout(Photos.imageJobTimer);
      Photos.imageSource = '';

      // If the job was successful, show the image.
      if (imageJob.result == 'success' && opt_image) {
        if (!imageJob.preload &&
            (imageJob.asset.url == Photos.imageSourceForDisplay)) {
          var imageHeight = $(opt_image)[0].naturalHeight;
          var imageWidth = $(opt_image)[0].naturalWidth;

          if (!window.innerHeight || !window.innerWidth) {
            logError('Invalid window size: window.innerHeight=' +
              window.innerHeight + ', window.innerWidth=' + window.innerWidth);
          }

          var imageAspectRatio = imageWidth / imageHeight;
          var windowAspectRatio = (
            window.innerWidth / window.innerHeight);

          // Determine CSS height, width, left, and top values to display the
          // new image with aspect-fit scaling.
          var scaledHeight = window.innerHeight;
          var scaledWidth = window.innerWidth;
          var scaledLeft = 0;
          var scaledTop = 0;

          if (!isNaN(imageAspectRatio) && !isNaN(windowAspectRatio)) {
            if (imageAspectRatio > windowAspectRatio) {
              // If the image is wider and shorter than the screen, reduce the
              // scaled height.
              scaledHeight = Math.round(
                window.innerWidth / imageAspectRatio);
              scaledTop = Math.round(
                (window.innerHeight - scaledHeight) / 2);
            } else {
              // If the image is thinner and taller than the screen, reduce the
              // scaled width.
              scaledWidth = Math.round(
                window.innerHeight * imageAspectRatio);
              scaledLeft = Math.round(
                (window.innerWidth - scaledWidth) / 2);
            }

            $(opt_image).css('height', scaledHeight);
            $(opt_image).css('width', scaledWidth);
            $(opt_image).css('left', scaledLeft);
            $(opt_image).css('top', scaledTop);
            $(opt_image).css('display', 'block');
          }

          $('#image-canvas').empty();
          $('#image-canvas').append($(opt_image));
          Photos.numPhotosShown++;

          displayPhoto();
        }

        // Store the casting client's sender id as active.
        Photos.activeSenderId = imageJob.senderId;
      }

      // Send responses to connected clients if this isn't a preload.
      if (!imageJob.preload) {
        var photosReceiver = this;
        this.castReceiverManager.getSenders().forEach(
          function(senderId) {
            var response = photosReceiver.makeResponse('newAsset');

            // Only the casting client receives additional metadata.
            if (senderId == imageJob.senderId) {
              response.payload = {
                'asset': imageJob.asset,
                'result': imageJob.result
              };

              photosReceiver.castMessageBus.send(senderId, response);
            } else if (imageJob.result == 'success') {
              // Other connected clients only receive a response if the job was
              // successful.
              photosReceiver.castMessageBus.send(senderId, response);
            }
          }
        );
      }

      // Log the result of the image job.
      if (FAST_PHOTOS_SHOW_LOGS) {
        if (imageJob.result == 'success') {
          if (imageJob.preload) {
            console.log('Finished preload\n' + JSON.stringify(imageJob));
          } else {
            console.log('Finished load\n' + JSON.stringify(imageJob));
          }
        } else {
          if (imageJob.preload) {
            console.log('Preload error\n' + JSON.stringify(imageJob));
          } else {
            console.log('Load error\n' + JSON.stringify(imageJob));
          }
        }
      }

      // Kick off the next image job.
      this.loadImage();
    },

    /**
     * Creates an object formatted for response to a sender. Populates the
     * object with some core data and the (optional) payload. If payload
     * evaluates to false, there will be no payload field on the returned
     * object.
     *
     * @param {String} messageName The name of the response message.
     * @param {Object=} opt_payload Option message-specific payload.
     * @return {!Object} The response object.
     */
    makeResponse: function(messageName, opt_payload) {
      var response = {};
      response.name = messageName;
      response.version = FAST_PHOTOS_PROTOCOL_VERSION;
      if (opt_payload) {
        response[KEY_PAYLOAD] = opt_payload;
      }
      return response;
    },

    /**
     * Only log when allowed
     *
     * @param {string} message what to log
     */
    log: function(message) {
      if (FAST_PHOTOS_SHOW_LOGS) {
        console.log(message);
      }
    },

    /**
     * Takes a url and checks to make sure it's from a valid domain and scheme
     *
     * @param {string} url to check against whitelist
     * @return {boolean} whether the given url is whitelisted
     */
    checkValidUrl: function(url) {
      var a = document.createElement('a');
      a.href = url;

      if (!this.checkValidScheme(a.protocol)) {
        return false;
      }

      var parts = a.hostname.split('.');
      if (parts.length < 2) {
        return false;
      }
      return true;

//      var domain = parts.slice(-2).join('.');
//      switch (domain) {
////        case 'github.com':
////          return true;
//        default:
//          return false;
//      }
    },

    /**
     * Checks if a particular scheme is whitelisted
     *
     * @param {string} scheme ending a colon
     * @return {boolean} whether the scheme is whitelisted or not
     */
    checkValidScheme: function(scheme) {
      switch (scheme) {
        case 'https:':
          return true;
        case 'http:':
          return true;
        default:
          return false;
      }
    }
  };

  // Expose this API.
  cast.Photos = Photos;
})();
