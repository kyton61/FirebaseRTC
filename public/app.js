// See:https://github.com/material-components/material-components-web/blob/master/packages/material-components-web/index.ts
mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

const configuration = {
  iceServers: [
    {
      urls: [
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

let localStream = null;
let roomDialog = null;
let roomId = null;
let localUserId = null;
let switchControl = null;

let peerConnections = {};
let dataChannels ={};
let remoteStreams = [];

function init() {
  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
	document.querySelector('#shareScreenBtn').addEventListener('click', shareScreen);
  roomDialog = new mdc.dialog.MDCDialog(document.querySelector('#room-dialog'));
	switchControl = new mdc.switchControl.MDCSwitch(document.querySelector('.mdc-switch'));
}

async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
	document.querySelector('#shareScreenBtn').disabled = false;

	// firestore接続用オブジェクトの作成
  const db = firebase.firestore();

	// firestoreコレクションroomsに任意の文字列のドキュメント作成
  const roomRef = await db.collection('rooms').doc();
	// ドキュメントの文字列をroom idとする
	roomId = roomRef.id

	// room idをjoinRoom()でgetするためのdummyドキュメントを登録
	roomRef.set({
		dummy: "dummy"
	});	

	// firestoreのroomメンバに自分自身（ローカルユーザ）を追加
	const localUserRef = await roomRef.collection('users').doc();
	// user idをローカル変数に代入
	localUserId = localUserRef.id
	console.log('local user id: ', localUserId);

	// firestoreに自分自身のuserIdを追加する
  localUserRef.set({
		userId: localUserId
	});

	// room idを画面に表示
  roomId = roomRef.id;
  console.log(`New room created. Room ID: ${roomRef.id}`);
  document.querySelector(
    '#currentRoom').innerText = `Current room is ${roomRef.id} - You are the caller!`;

	// SDP offerの待ち受けとSDP answerの返信
	await waitOffer(roomRef);

}

function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
	document.querySelector('#shareScreenBtn').disabled = false;

	// ダイアログ表示
  document.querySelector('#confirmJoinBtn').
      addEventListener('click', async () => {
        roomId = document.querySelector('#room-id').value;
        console.log('Join room: ', roomId);
        document.querySelector(
            '#currentRoom').innerText = `Current room is ${roomId} - You are the callee!`;
        await joinRoomById(roomId);
      }, {once: true});
  roomDialog.open();
}

async function joinRoomById(roomId) {
	// firestore接続用オブジェクトの作成
  const db = firebase.firestore();

	// firestoreからユーザが入力したroom idの情報を取得
  const roomRef = db.collection('rooms').doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();
  console.log('Got room:', roomSnapshot.exists);

	// roomIDが存在する場合
  if (roomSnapshot.exists) {

		// firestoreのusersコレクションのドキュメントIDから自分自身のユーザIDを取得
		const localUserRef = await roomRef.collection('users').doc();
		localUserId = localUserRef.id
		console.log('local user id: ', localUserId);

		// 入室済みのユーザIDを取得して、 peer connectionの作成
		roomRef.collection('users').get().then(querySnapshot => {
      querySnapshot.forEach(user => {
				// ユーザIDが自分自身と異なる場合
				if (user.id != localUserId) {
					// peerConnection作成
					peerConnections[user.id] = new RTCPeerConnection(configuration)
					console.log('Create PeerConnection with configuration: ', configuration);

					// peerConnectionのイベントリスナー登録
					registerPeerConnectionListeners(user.id);
					console.log('Register peerConnection listener: ', user.id);

					// firestoreのpeerConnectionsコレクションへの参照を準備
					const peerConnectionsRef = roomRef.collection('peerConnections').doc();

					// ローカルストリーム情報をpeerConnectionオブジェクトに追加
					localStream.getTracks().forEach(track => {
            peerConnections[user.id].addTrack(track, localStream);
          });
	
				  // SDP Offerの作成
					onCreateOffer(user.id, peerConnectionsRef);

					// peerConnectionのトラックイベントをリッスン。リモートストリームの入力を監視する
					onRemoteStream(user.id);
				}
			});
		});

		// firestoreに自分自身のuserを追加する
		localUserRef.set({
		  userId: localUserId
		});

		// SDP answer待機
		roomRef.collection('peerConnections').where('offerUserId', '==', localUserId).onSnapshot(snapshot => {
			snapshot.docChanges().forEach(async change => {
				// データが変更されたとき
				if (change.type === 'modified') {
					const answerUserId = change.doc.data().answerUserId;
					const answer = change.doc.data().answer;
					const peerConnectionId = change.doc.id;

					if (!peerConnections[answerUserId].currentRemoteDescription && answer) {
						// SDP answerをpeer connectionにセット
						await peerConnections[answerUserId].setRemoteDescription(new RTCSessionDescription(answer));
						console.log('Got sdp answer from user: ', answerUserId);

						// リモートユーザのICE Candidatesを取得する
						await onIceCandidates(answerUserId, roomRef, peerConnectionId, 'calleeCandidates');
					}
				}
			});
		});

		// SDP offerの待ち受けとSDP answerの返信
		await waitOffer(roomRef)
	}
}

async function waitOffer(roomRef) {
	// 自分宛てのSDP Offerをリッスン
	// memo: where() operator "!=" was released in version 7.21.0!!
  roomRef.collection('peerConnections').where("answerUserId", "==", localUserId).onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      // データが変更されたとき（SDP offerが追加されたとき）
      if (change.type === 'modified') {
				//debug
				console.log('peer connections collection is being modified: ', change.doc.data());

        const offerUserId = change.doc.data().offerUserId;
        const offer = change.doc.data().offer;
        const peerConnectionId = change.doc.id;
				
				// SDP Offerが格納された場合、peerConnectionの作成と初期化
				if (!peerConnections[offerUserId] && offer) {
					console.log('Create PeerConnection with configuration: ', configuration);
          peerConnections[offerUserId] = new RTCPeerConnection(configuration)

					// peerConnectionのイベントリスナー登録
          registerPeerConnectionListeners(offerUserId);
          console.log('Register peerConnection listener: ', offerUserId);

          // ローカルストリーム情報をpeerConnectionオブジェクトに追加
					localStream.getTracks().forEach(track => {
						peerConnections[offerUserId].addTrack(track, localStream);
					});

          console.log('Offer user: ', offerUserId);
          console.log('Get remote sdp offer: ', offer);

          // firestoreのpeerConnectionsコレクションへの参照を準備
          const peerConnectionsRef = await roomRef.collection('peerConnections').doc(peerConnectionId);

          // peerConnections[offerUserId]のICE Candidateをリッスン
          peerConnections[offerUserId].addEventListener('icecandidate', event => {
            if (!event.candidate) {
              console.log('Got final candidate!');
              return;
           }
            console.log('Got cadidate: ', event.candidate);
            // firestoreにローカルのICE Candidate情報を登録
            peerConnectionsRef.collection('calleeCandidates').add(event.candidate.toJSON());
          });

          // peerConnectionのトラックイベントをリッスン。リモートストリームの入力を監視する
					await onRemoteStream(offerUserId);

          // firestoreから取得したSDP OfferをpeerConnectionにセットする
          await peerConnections[offerUserId].setRemoteDescription(new RTCSessionDescription(offer));

          // SDP Answerを返す
					await onCreateAnswer(offerUserId, peerConnectionsRef);

					// リモートユーザのICE Candidatesを取得する
					await onIceCandidates(offerUserId, roomRef, peerConnectionId, 'callerCandidates');
        }
      }
    });
  });
}

async function onCreateOffer(userId, peerConnectionsRef) {
	// firestoreにoffer userとanswer userを登録
	peerConnectionsRef.set({
    offerUserId: localUserId,
    answerUserId: userId,
  });

	// peerConnections[user.id]のICE Candidateをリッスン
  peerConnections[userId].addEventListener('icecandidate', event => {
    if (!event.candidate) {
      console.log('Got final candidate!');
      return;
    }
    console.log('Got cadidate: ', event.candidate);
    // firestoreにローカルのICE Candidate情報を登録
    peerConnectionsRef.collection('callerCandidates').add(event.candidate.toJSON());
  });

	// SDP Offerの作成
  peerConnections[userId].createOffer().then(offer => {
    peerConnections[userId].setLocalDescription(offer);
    console.log('Created offer:', offer);

    const peerConnWithOffer = {
      'offer': {
        type: offer.type,
        sdp: offer.sdp,
      },
    };
    // firestoreにSDP Offerを登録
    peerConnectionsRef.update(peerConnWithOffer);
  });
}

async function onCreateAnswer(userId, peerConnectionsRef) {
	peerConnections[userId].createAnswer().then(answer => {
    peerConnections[userId].setLocalDescription(answer);
    console.log('Created answer: ', answer);

    const peerConnWithAnswer = {
      'answer': {
        type: answer.type,
        sdp: answer.sdp,
      },
    };
    peerConnectionsRef.update(peerConnWithAnswer);
    console.log('Set answer to firestore!');
  });
}

async function onIceCandidates(userId, roomRef, peerConnectionId, callerOrCallee) {
	roomRef.collection('peerConnections').doc(peerConnectionId).collection(callerOrCallee).onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added') {
        console.log('Got ice candidates from caller!');
				let data = change.doc.data();

        console.log(`got remote ICE candidate: ${JSON.stringify(data)}`);
        // peerConnectionにICE Candidatesを登録する
				await peerConnections[userId].addIceCandidate(new RTCIceCandidate(data)).then(onAddIceCandidateSuccess, onAddIceCandidateError);
      }
    });
  });
}

function onAddIceCandidateSuccess() {
  console.log('AddIceCandidate success.');
}

function onAddIceCandidateError(error) {
  console.log(`Failed to add ICE candidate: ${error.toString()}`);
}

async function onRemoteStream(userId) {
	peerConnections[userId].addEventListener('track', event => {
		remoteStream = new MediaStream();
    console.log('Got remote track:', event.streams[0]);
    event.streams[0].getTracks().forEach(track => {
      console.log('Add a track to the remoteStream:', track);
      remoteSender = remoteStream.addTrack(track);
    });
    remoteStreams.push(remoteStream);
    // TODO:#remoteVideoタグを接続数に応じて変更できるようにする
		if (remoteStreams.length == 1) {
			document.querySelector('#remoteVideo-1').srcObject = remoteStreams[0];
		} else if (remoteStreams.length == 2) {
      document.querySelector('#remoteVideo-2').srcObject = remoteStreams[1];
    } else if (remoteStreams.length >= 3) {
			document.querySelector('#remoteVideo-3').srcObject = remoteStreams[2];
		}
  });
}

function updateAudioTrack() {
	if (localStream) {
		if (document.getElementById('micBtn').checked) {
			localStream.getAudioTracks()[0].enabled = true;
			//switchControl.setChecked(true);
			console.log('Audio track on');
		} else {
			localStream.getAudioTracks()[0].enabled = false;
			//switchControl.setChecked(false);
			console.log('Audio track off');
		}
	} else {
		console.log('Don\'t allowed using audio track.');
	}
}

async function shareScreen(e) {
	document.querySelector('#shareScreenBtn').disabled = true;

	await navigator.mediaDevices.getDisplayMedia(
		{video: true})
	.then(async stream => {
		document.querySelector('#localVideo').srcObject = stream;
		// スクリーンストリームからビデオトラックを取り出す
		let screenTrack = stream.getVideoTracks()[0];

		// 画面共有からの入力に切り替える
		// TODO:RTCRtpTransceiverを理解する
		Object.keys(peerConnections).forEach(id => {
			// peer connectionから送信側のRTCRtpTransceiverを取り出す
			let sender = peerConnections[id].getSenders().find(sdr => {
			  return sdr.track.kind == screenTrack.kind;
			});
			sender.replaceTrack(screenTrack);
			console.log('sender\'s new_track: ', screenTrack);
		});
		console.log('Start screen sharing.');

		// 画面共有を終了したらカメラからの入力に戻す
		stream.getVideoTracks()[0].addEventListener('ended', () => {
			document.querySelector('#localVideo').srcObject = localStream;
			let localStreamTrack = localStream.getVideoTracks()[0];
			Object.keys(peerConnections).forEach(id => {
				let sender = peerConnections[id].getSenders().find(sdr => {
					return sdr.track.kind == localStreamTrack.kind;
				});
				sender.replaceTrack(localStreamTrack);
			});
			document.querySelector('#shareScreenBtn').disabled = false;
			console.log('End screen sharing.');
		});
	})
	.catch(error => {
		console.log('getDesplayMedia error: ', error);
	});
}
	
async function openUserMedia(e) {
	// ローカル環境のカメラとマイク情報をlocalVideo属性に設定
  const stream = await navigator.mediaDevices.getUserMedia(
      {video: true, audio: true});
  document.querySelector('#localVideo').srcObject = stream;
  localStream = stream;

  console.log('Stream:', document.querySelector('#localVideo').srcObject);

  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
	document.querySelector('#shareScreenBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = false;
	document.querySelector('#micBtn').disabled = false;
}

async function hangUp(e) {
  const tracks = document.querySelector('#localVideo').srcObject.getTracks();
  tracks.forEach(track => {
    track.stop();
  });

	if (remoteStreams.length) {
		remoteStreams.forEach(remoteStream => {
			remoteStream.getTracks().forEach(track => track.stop());
		});
	}

	if (peerConnections.legth) {
		peerConnections.forEach(peerConnection => {
			peerConnection.close();
		});
	}

  document.querySelector('#localVideo').srcObject = null;
	// TODO:remoteVideoを動的に増減させる
  document.querySelector('#remoteVideo-1').srcObject = null;
	document.querySelector('#remoteVideo-2').srcObject = null;
	document.querySelector('#remoteVideo-3').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
	document.querySelector('#shareScreenBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
	document.querySelector('#micBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  // Delete user on hangup
  if (roomId) {
    const db = firebase.firestore();
		db.collection('rooms').doc(roomId).collection('users').doc(localUserId).delete().then(function() {
			console.log('delete user');
		}).catch(error => {
			console.error('Error removing document: ', error);
		});
		// ローカルユーザのサブコレクションiceCandidates配下のドキュメント全削除
    const peerConnectionsRef = await db.collection('rooms').doc(roomId).collection('peerConnections').get();
    peerConnectionsRef.forEach(async peerConn => {
			console.log('debug: delete bofore:', peerConn.data().offerUserId);
			if (peerConn.data().offerUserId == localUserId || peerConn.data().answerUserId == localUserId) {
				console.log('delete peer connections collection\'s document:', peerConn.data().offerUserId);
				await peerConn.ref.delete();
			}
    });
  }

  document.location.reload(true);
}

// peerConnectionオブジェクトを監視し、状態変化があればコンソールログに表示
function registerPeerConnectionListeners(userId) {
  peerConnections[userId].addEventListener('icegatheringstatechange', () => {
    console.log(
        `ICE gathering state changed ${userId} : ${peerConnections[userId].iceGatheringState}`);
  });

  peerConnections[userId].addEventListener('connectionstatechange', () => {
    console.log(`Connection state change ${userId} : ${peerConnections[userId].connectionState}`);
  });

  peerConnections[userId].addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change ${userId} : ${peerConnections[userId].signalingState}`);
  });

  peerConnections[userId].addEventListener('iceconnectionstatechange ', () => {
    console.log(
        `ICE connection state change ${userId} : ${peerConnections[userId].iceConnectionState}`);
  });
}

init();
