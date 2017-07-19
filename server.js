/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var express = require('express');
var ws = require('ws');
var minimist = require('minimist');
var url = require('url');
var kurento = require('kurento-client');
var https = require('https');
var fs = require('fs');

var argv = minimist(process.argv.slice(2), {
  default: {
      as_uri: "http://localhost:8443/",
      ws_uri: "ws://localhost:8888/kurento"
  }
});

var app = express();

/*
 * Definition of global variables.
 */

var kurentoClient = null;
var userRegistry = new UserRegistry();
var roomRegistry = new RoomRegistry();
var pipelines = {};
var candidatesQueue = {};
var idCounter = 0;
var candidates_ready = {};
var recordsCounter = 0;

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

/*
 * Definition of helper classes
 */

// Represents caller and callee sessions
function UserSession(id, name, ws) {
    this.id = id;
    this.name = name;
    this.ws = ws;
    this.peer = null;
    this.sdpOffer = null;
}

UserSession.prototype.sendMessage = function(message) {
    this.ws.send(JSON.stringify(message));
}

// Represents registrar of users
function UserRegistry() {
    this.usersById = {};
    this.usersByName = {};
}

UserRegistry.prototype.register = function(user) {
    this.usersById[user.id] = user;
    this.usersByName[user.name] = user;
}

UserRegistry.prototype.unregister = function(id) {
    var user = this.getById(id);
    if (user) delete this.usersById[id]
    if (user && this.getByName(user.name)) delete this.usersByName[user.name];
}

UserRegistry.prototype.getById = function(id) {
    return this.usersById[id];
}

UserRegistry.prototype.getByName = function(name) {
    return this.usersByName[name];
}

UserRegistry.prototype.removeById = function(id) {
    var userSession = this.usersById[id];
    if (!userSession) return;
    delete this.usersById[id];
    delete this.usersByName[userSession.name];
}

function Room(id){
    this.id = id;
    this.participants = new Array();    
}
Room.prototype.join = function(user)
{
    if (!this.participants[user.id])
    {
        onUserJoin(user);
        this.participants[user.id] = user;
    }
}
Room.prototype.leave = function(user)
{
    if (this.participants[user.id])
    {
        onUserLeft(user);
        delete this.participants[user.id];
    }
}
Room.prototype.broadcast = function(msg)
{
    this.participants.forEach(function(participant, i, arr){
        participant.sendMessage(msg);
    });
}
Room.prototype.broadcastFrom = function(user, msg)
{
    this.participants.forEach(function(participant, i, arr){
        if (participant !== user)
            participant.sendMessage(msg);
    });
};

function RoomRegistry(){
    this.roomsById = {};
    this.roomsById[1] = new Room(1);
}
RoomRegistry.prototype.register = function(room) {
    if (!this.roomsById[room.id])
    {
        this.roomsById[id] = room;
    }
}
// Represents a B2B active call
function CallMediaPipeline() {
    this.pipeline = null;
    this.webRtcEndpoint = {};
	this.recorderEndpoint = null;
}

CallMediaPipeline.prototype.createPipeline = function(callerId, calleeId, ws, callback) {
    var self = this;
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

			pipeline.create('WebRtcEndpoint', function(error, callerWebRtcEndpoint) {
				if (error) {
					pipeline.release();
					return callback(error);
				}

				if (candidatesQueue[callerId]) {
					while(candidatesQueue[callerId].length) {
						var candidate = candidatesQueue[callerId].shift();
						callerWebRtcEndpoint.addIceCandidate(candidate);
					}
				}

				callerWebRtcEndpoint.on('OnIceCandidate', function(event) {
					var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
					userRegistry.getById(callerId).ws.send(JSON.stringify({
						id : 'iceCandidate',
						candidate : candidate
					}));
				});

				pipeline.create('WebRtcEndpoint', function(error, calleeWebRtcEndpoint) {
					if (error) {
						pipeline.release();
						return callback(error);
					}

					if (candidatesQueue[calleeId]) {
						while(candidatesQueue[calleeId].length) {
							var candidate = candidatesQueue[calleeId].shift();
							calleeWebRtcEndpoint.addIceCandidate(candidate);
						}
					}

					calleeWebRtcEndpoint.on('OnIceCandidate', function(event) {
						var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
						userRegistry.getById(calleeId).ws.send(JSON.stringify({
							id : 'iceCandidate',
							candidate : candidate
						}));
					});

					pipeline.create('Composite', function(error, _composite) {
						if (error) {
							pipeline.release();
							return callback(error);
						}

						_composite.createHubPort(function(error, _callerHubport) {
							if (error) {
								pipeline.release();
								return callback(error);
							}

							_composite.createHubPort(function(error, _calleeHubport) {
								if (error) {
									pipeline.release();
									return callback(error);
								}

								_composite.createHubPort(function(error, _recorderHubport) {
									if (error) {
										pipeline.release();
										return callback(error);
									}

									recordsCounter++;

									var recorderParams = {
										mediaProfile: 'MP4',
										uri : "file:///tmp/kurento-one2one-composite-" + recordsCounter + ".mp4"
									};

									pipeline.create('RecorderEndpoint', recorderParams, function(error, recorderEndpoint) {
										if (error) {
											pipeline.release();
											return callback(error);
										}

										self.recorderEndpoint = recorderEndpoint;

										_recorderHubport.connect(recorderEndpoint, function(error) {
											if (error) {
												pipeline.release();
												return callback(error);
											}

											callerWebRtcEndpoint.connect(_callerHubport, function(error) {
												if (error) {
													pipeline.release();
													return callback(error);
												}
												calleeWebRtcEndpoint.connect(_calleeHubport, function(error) {
													if (error) {
														pipeline.release();
														return callback(error);
													}

													console.log('Hubports are created');

													_callerHubport.connect(callerWebRtcEndpoint, function(error) {
														if (error) {
															pipeline.release();
															return callback(error);
														}
														_calleeHubport.connect(calleeWebRtcEndpoint, function(error) {
															if (error) {
																pipeline.release();
																return callback(error);
															}

															callerWebRtcEndpoint.on('OnIceGatheringDone', function(error) {
																candidates_ready[callerId] = true;
																if (candidates_ready[calleeId]) {
																	recorderEndpoint.record();
																}
															});
															calleeWebRtcEndpoint.on('OnIceGatheringDone', function(error) {
																candidates_ready[calleeId] = true;
																if (candidates_ready[callerId]) {
																	recorderEndpoint.record();
																}
															});

															self.pipeline = pipeline;
															self.webRtcEndpoint[callerId] = callerWebRtcEndpoint;
															self.webRtcEndpoint[calleeId] = calleeWebRtcEndpoint;
															callback(null);
														});
													});
												});
											});
										});
									});
								});
							});
						});
					});
				});
            });
        });
    });
};

CallMediaPipeline.prototype.generateSdpAnswer = function(id, sdpOffer, callback) {
    this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
    this.webRtcEndpoint[id].gatherCandidates(function(error) {
        if (error) {
            return callback(error);
        }
    });
};

CallMediaPipeline.prototype.release = function() {
    if (this.pipeline) this.pipeline.release();
    this.pipeline = null;
};

function OnUserLeft(user, room)
{

}
function OnUserJoin(user, room)
{

}
// Represents player pipeline
function PlayMediaPipeline() {
    this.pipeline = null;
    this.webRtcEndpoint = {};
	this.playerEndpoint = null;
}

PlayMediaPipeline.prototype.createPipeline = function(callerId, ws, callback) {
    var self = this;
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

			pipeline.create('WebRtcEndpoint', function(error, callerWebRtcEndpoint) {
				if (error) {
					pipeline.release();
					return callback(error);
				}

				if (candidatesQueue[callerId]) {
					while(candidatesQueue[callerId].length) {
						var candidate = candidatesQueue[callerId].shift();
						callerWebRtcEndpoint.addIceCandidate(candidate);
					}
				}

				callerWebRtcEndpoint.on('OnIceCandidate', function(event) {
					var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
					userRegistry.getById(callerId).ws.send(JSON.stringify({
						id : 'iceCandidate',
						candidate : candidate
					}));
				});

				var options = {
								uri : "file:///tmp/kurento-one2one-composite-" + recordsCounter + ".mp4"
								};

				pipeline.create("PlayerEndpoint", options, function(error, player) {
					if (error) return onError(error);

					callerWebRtcEndpoint.on('OnIceGatheringDone', function(error) {
						player.play();
					});

					player.on('EndOfStream', function(event){
						userRegistry.getById(callerId).sendMessage({id : 'stopPlay'});
						stop(callerId);
					});

					player.connect(callerWebRtcEndpoint, function(error) {
						if (error) return onError(error);

						self.playerEndpoint = player;
						self.pipeline = pipeline;
						self.webRtcEndpoint[callerId] = callerWebRtcEndpoint;
						callback(null);
					});
				});
            });
        });
    });
};

PlayMediaPipeline.prototype.generateSdpAnswer = function(id, sdpOffer, callback) {
    this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
    this.webRtcEndpoint[id].gatherCandidates(function(error) {
        if (error) {
            return callback(error);
        }
    });
};

PlayMediaPipeline.prototype.release = function() {
    if (this.pipeline) this.pipeline.release();
    this.pipeline = null;
};



/*
 * Server startup
 */
var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2onecomposrec'
});

wss.on('connection', function(ws) {
    var sessionId = nextUniqueId();
    console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
        userRegistry.unregister(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        if (message.id !== 'onIceCandidate')
			console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'register':
            register(sessionId, message.name, ws);
            break;

        case 'call':
            call(sessionId, message.to, message.from, message.sdpOffer);
            break;

        case 'incomingCallResponse':
            incomingCallResponse(sessionId, message.from, message.callResponse, message.sdpOffer, ws);
            break;

        case 'play':
            play(sessionId, message.sdpOffer);
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            var message = 'Coult not find media server at address ' + argv.ws_uri;
            return callback(message + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function stop(sessionId) {
    if (!pipelines[sessionId]) {
        return;
    }

    var pipeline = pipelines[sessionId];
    delete pipelines[sessionId];

	if (pipeline.recorderEndpoint)
		pipeline.recorderEndpoint.stop();

	if (pipeline.playerEndpoint)
		pipeline.playerEndpoint.stop();

    pipeline.release();
    var stopperUser = userRegistry.getById(sessionId);
    var stoppedUser = userRegistry.getByName(stopperUser.peer);
    stopperUser.peer = null;

    if (stoppedUser) {
        stoppedUser.peer = null;
        delete pipelines[stoppedUser.id];
        var message = {
            id: 'stopCommunication',
            message: 'remote user hanged out'
        }
        stoppedUser.sendMessage(message)
    }

    clearCandidatesQueue(sessionId);
}

function incomingCallResponse(calleeId, from, callResponse, calleeSdp, ws) {

    clearCandidatesQueue(calleeId);

    function onError(callerReason, calleeReason) {
        if (pipeline) pipeline.release();
        if (caller) {
            var callerMessage = {
                id: 'callResponse',
                response: 'rejected'
            }
            if (callerReason) callerMessage.message = callerReason;
            caller.sendMessage(callerMessage);
        }

        var calleeMessage = {
            id: 'stopCommunication'
        };
        if (calleeReason) calleeMessage.message = calleeReason;
        callee.sendMessage(calleeMessage);
    }

    var callee = userRegistry.getById(calleeId);
    if (!from || !userRegistry.getByName(from)) {
        return onError(null, 'unknown from = ' + from);
    }
    var caller = userRegistry.getByName(from);

    if (callResponse === 'accept') {
        var pipeline = new CallMediaPipeline();
        pipelines[caller.id] = pipeline;
        pipelines[callee.id] = pipeline;

        pipeline.createPipeline(caller.id, callee.id, ws, function(error) {
            if (error) {
                return onError(error, error);
            }

            pipeline.generateSdpAnswer(caller.id, caller.sdpOffer, function(error, callerSdpAnswer) {
                if (error) {
                    return onError(error, error);
                }

                pipeline.generateSdpAnswer(callee.id, calleeSdp, function(error, calleeSdpAnswer) {
                    if (error) {
                        return onError(error, error);
                    }

                    var message = {
                        id: 'startCommunication',
                        sdpAnswer: calleeSdpAnswer
                    };
                    callee.sendMessage(message);

                    message = {
                        id: 'callResponse',
                        response : 'accepted',
                        sdpAnswer: callerSdpAnswer
                    };
                    caller.sendMessage(message);
                });
            });
        });
    } else {
        var decline = {
            id: 'callResponse',
            response: 'rejected',
            message: 'user declined'
        };
        caller.sendMessage(decline);
    }
}

function call(callerId, to, from, sdpOffer) {
    clearCandidatesQueue(callerId);

    var caller = userRegistry.getById(callerId);
    var rejectCause = 'User ' + to + ' is not registered';
    if (userRegistry.getByName(to)) {
        var callee = userRegistry.getByName(to);
        caller.sdpOffer = sdpOffer
        callee.peer = from;
        caller.peer = to;
        var message = {
            id: 'incomingCall',
            from: from
        };
        try{
            return callee.sendMessage(message);
        } catch(exception) {
            rejectCause = "Error " + exception;
        }
    }
    var message  = {
        id: 'callResponse',
        response: 'rejected: ',
        message: rejectCause
    };
    caller.sendMessage(message);
}

function play(callerId, sdpOffer) {
    clearCandidatesQueue(callerId);

    var caller = userRegistry.getById(callerId);

	caller.sdpOffer = sdpOffer;

    clearCandidatesQueue(callerId);

    function onError(callerReason) {
        if (caller) {
            var callerMessage = {
                id: 'playResponse',
                response: 'rejected'
            };
            if (callerReason) callerMessage.message = callerReason;
            caller.sendMessage(callerMessage);
        }
    }

	if (!recordsCounter) {
		return onError('There are no record.');
	}

	var pipeline = new PlayMediaPipeline();

	pipelines[caller.id] = pipeline;

	pipeline.createPipeline(caller.id, ws, function(error) {
		if (error) {
			return onError(error);
		}
		console.log('Pipeline is created.');

		pipeline.generateSdpAnswer(caller.id, sdpOffer, function(error, callerSdpAnswer) {
			if (error) {
				return onError(error);
			}

			var message = {
				id: 'playResponse',
				response : 'accepted',
				sdpAnswer: callerSdpAnswer
			};
			caller.sendMessage(message);
		});
	});
}


function register(id, name, ws, callback) {
    function onError(error) {
        ws.send(JSON.stringify({id:'registerResponse', response : 'rejected ', message: error}));
    }

    if (!name) {
        return onError("empty user name");
    }

    if (userRegistry.getByName(name)) {
        return onError("User " + name + " is already registered");
    }

    userRegistry.register(new UserSession(id, name, ws));
    try {
        ws.send(JSON.stringify({id: 'registerResponse', response: 'accepted'}));
    } catch(exception) {
        onError(exception);
    }
}

function clearCandidatesQueue(sessionId) {
    if (candidatesQueue[sessionId]) {
        delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);
    var user = userRegistry.getById(sessionId);

    if (pipelines[user.id] && pipelines[user.id].webRtcEndpoint && pipelines[user.id].webRtcEndpoint[user.id]) {
        var webRtcEndpoint = pipelines[user.id].webRtcEndpoint[user.id];
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        if (!candidatesQueue[user.id]) {
            candidatesQueue[user.id] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));