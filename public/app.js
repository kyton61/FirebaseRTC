// DocumentのquerySelector()メソッドは指定されたセレクタのグループに一致する、文書内の最初のElementを返す
// 一致するものが見つからない場合はnullを返す
mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

// ice serverにgoogleのstunサーバを登録
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

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let roomDialog = null;
let roomId = null;

function init() {
	// id属性：cameraBtnがクリックされた時にopenUserMedia()関数を呼び出す
	// target.addEventListener(type, listener[, options]);
	// 特定のイベントが対象に配信されるたびに呼び出される関数を設定します。
	// 対象としてよくあるものはElement,Document,Windowですが、あらゆるオブジェクトが対象となる
  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
	// id属性：hangupBtnがクリックされた時にhangUp関数を呼び出す
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
	// id属性：createBtnがクリックされた時にcreateRoom()関数を呼び出す
  document.querySelector('#createBtn').addEventListener('click', createRoom);
	// id属性：joinBtnがクリックされた時にjoinRoom関数を呼び出す
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
	// MDCDialogオブジェクトをroomDialog変数に格納する
	// mdc_dialogを使うときのおまじない
	// #はid属性のセレクタを表す
  roomDialog = new mdc.dialog.MDCDialog(document.querySelector('#room-dialog'));
}

async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();
	// roomsというコレクション内に作ったドキュメントへのリファレンスをroomRefオブジェクトに格納
	// .doc()とするとドキュメント名に勝手に一意なIDがされる
  const roomRef = await db.collection('rooms').doc();

  console.log('Create PeerConnection with configuration: ', configuration);

	// ＃＃＃ice serverの情報をもとにRTCPeerConnectionオブジェクトを作成
  peerConnection = new RTCPeerConnection(configuration);

  registerPeerConnectionListeners();

	// ＃＃＃peerConnectinにローカルデバイスのtrack(音声、映像)を追加する
	// =>はallow関数。 関数式の簡易表示。
	// getTracks()で得られた配列の値を trackにいれて、peerConnection.addTrackを実行
  localStream.getTracks().forEach(track => {
		// addTrackはストリームへ新しいトラックを追加するメソッド
    peerConnection.addTrack(track, localStream);
  });

	
	// roomRefオブジェクトから'callerCandidates'コレクションを取得
  const callerCandidatesCollection = roomRef.collection('callerCandidates');

	// ＃＃＃発信側のICE Candidates(通信経路候補)を取得できた際の処理を記述
  peerConnection.addEventListener('icecandidate', event => {
    if (!event.candidate) {
      console.log('Got final candidate!');
      return;
    }
    console.log('Got candidate: ', event.candidate);
		// シグナリングサーバーに登録している？発信側の通信経路に値をjson型式で追加
    callerCandidatesCollection.add(event.candidate.toJSON());
  });

  // ＃＃＃ローカルデバイスのSDPオファーを作成し、シグナリングサーバに登録
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  console.log('Created offer:', offer);

  const roomWithOffer = {
    'offer': {
      type: offer.type,
      sdp: offer.sdp,
    },
  };
	// set()メソッドでドキュメントの追加
	// roomコレクションの中にofferサブコレクション追加
	// データはtypeとsdp
  await roomRef.set(roomWithOffer);
	// db.collection('rooms').doc();で追加したID（＝ドキュメント名）を取得
  roomId = roomRef.id;
  console.log(`New room created with SDP offer. Room ID: ${roomRef.id}`);
  document.querySelector(
      '#currentRoom').innerText = `Current room is ${roomRef.id} - You are the caller!`;

	// ＃＃＃ここから、リモートデバイス側のtrack,sdp,iceをリッスン
	// EventListenerで上記を検知した場合に、接続を開始する
  peerConnection.addEventListener('track', event => {
    console.log('Got remote track:', event.streams[0]);
    event.streams[0].getTracks().forEach(track => {
      console.log('Add a track to the remoteStream:', track);
      remoteStream.addTrack(track);
    });
  });

  // Listening for remote session description below
	// onSnapshotでroomRefオブジェクトのすべてのドキュメントを取得する
  roomRef.onSnapshot(async snapshot => {
		// ドキュメントの中のデータを変数dataに代入
    const data = snapshot.data();
		// 現在のリモートディスクリプションがnull　かつ　データにSDPアンサーが入っている場合
    if (!peerConnection.currentRemoteDescription && data && data.answer) {
      console.log('Got remote description: ', data.answer);
			// peerConnectionにSDPアンサーを登録する
      const rtcSessionDescription = new RTCSessionDescription(data.answer);
      await peerConnection.setRemoteDescription(rtcSessionDescription);
    }
  });
  // Listening for remote session description above

	// roomRefオブジェクトの'calleeCandidates'コレクションのすべてのドキュメントを取得する
  roomRef.collection('calleeCandidates').onSnapshot(snapshot => {
		// ドキュメントの追加・削除・変更を監視
    snapshot.docChanges().forEach(async change => {
			// データが追加されたとき
      if (change.type === 'added') {
        let data = change.doc.data();
        console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
				// リモート側のICE CandidtesをpeerConnectionに追加する
				// ★ローカル側のpeerConnectionオブジェクトに、DBからリモート側のiceをセットする
        await peerConnection.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  });
}

function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

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
  const db = firebase.firestore();
	// roomsコレクションの中のroomIdドキュメント値を取得
  const roomRef = db.collection('rooms').doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();
  console.log('Got room:', roomSnapshot.exists);

	// roomIDが存在する場合
  if (roomSnapshot.exists) {
    console.log('Create PeerConnection with configuration: ', configuration);
		// RTCpeerConnectionオブジェクトをconfigから生成(=calleerとcalleeは同じturnサーバを使う)
    peerConnection = new RTCPeerConnection(configuration);
    registerPeerConnectionListeners();
		// (remote側の)ローカルストリーム情報をpeerConnectionオブジェクトにに追加
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

		// roomRefオブジェクトに'calleeCandidates'コレクションを追加する
    const calleeCandidatesCollection = roomRef.collection('calleeCandidates');
		// ICE Candidateが登録されたことを監視
    peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        console.log('Got final candidate!');
        return;
      }
      console.log('Got candidate: ', event.candidate);
			// ICE Candidate情報をcalleeCandidateコレクションに追加する
      calleeCandidatesCollection.add(event.candidate.toJSON());
    });

		// trackが再生された場合（＝カメラとマイク？が有効化された場合）
    peerConnection.addEventListener('track', event => {
      console.log('Got remote track:', event.streams[0]);
      event.streams[0].getTracks().forEach(track => {
        console.log('Add a track to the remoteStream:', track);
				// リモートストリームにtrackを追加する
        remoteStream.addTrack(track);
      });
    });

    // roomのデータからofferの値を取得
    const offer = roomSnapshot.data().offer;
    console.log('Got offer:', offer);
		// リモート側のSDPにオファー値をセットする
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
		// リモート側のSDPからアンサー値を取得する
    const answer = await peerConnection.createAnswer();
    console.log('Created answer:', answer);
		// ローカル側のSDPにアンサー値をセットする
    await peerConnection.setLocalDescription(answer);

    const roomWithAnswer = {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
    };
		// ドキュメントの特定のフィールドをupdateで更新 or 追加
		// すでに存在するroomのanswerサブコレクションを更新
		// DBのanswer値を追加することで、createRoom関数で監視しているローカル側のsdp,iceを更新する
    await roomRef.update(roomWithAnswer);

    // callerCandidatesコレクションのすべてのドキュメントを取得する
    roomRef.collection('callerCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
				// データが追加された場合
        if (change.type === 'added') {
          let data = change.doc.data();
          console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
					// リモート側のpeerConnectionに、ローカル側のiceをセットする。値はDBから取得する
          await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  }
}

async function openUserMedia(e) {
	// streamにビデオと音声のデバイス情報を格納
  const stream = await navigator.mediaDevices.getUserMedia(
      {video: true, audio: true});
	// index.htmlのlocalVideo属性に取得したデバイス情報を格納→ここで映像が流れる
  document.querySelector('#localVideo').srcObject = stream;
	// stream情報をlocalStreamオブジェクトに格納→createRoom,joinroom関数で利用
  localStream = stream;
	// リモート側のストリーム情報をremoteVideo属性に格納
  remoteStream = new MediaStream();
  document.querySelector('#remoteVideo').srcObject = remoteStream;

  console.log('Stream:', document.querySelector('#localVideo').srcObject);
	// カメラ有効化ボタン以外を有効化する
  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
  document.querySelector('#hangupBtn').disabled = false;
}

async function hangUp(e) {
  const tracks = document.querySelector('#localVideo').srcObject.getTracks();
  tracks.forEach(track => {
    track.stop();
  });

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
  }

  if (peerConnection) {
    peerConnection.close();
  }

  document.querySelector('#localVideo').srcObject = null;
  document.querySelector('#remoteVideo').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  // Delete room on hangup
  if (roomId) {
    const db = firebase.firestore();
    const roomRef = db.collection('rooms').doc(roomId);
		// roomIdのサブコレクションcalleeCandidates配下のドキュメント全削除
    const calleeCandidates = await roomRef.collection('calleeCandidates').get();
    calleeCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
		// roomIdのサブコレクションcallerCandidates配下のドキュメント全削除
    const callerCandidates = await roomRef.collection('callerCandidates').get();
    callerCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
		// roomIdドキュメント削除※ドキュメント削除しても配下のサブコレクションは削除されない
    await roomRef.delete();
  }

  document.location.reload(true);
}

// peerConnectionオブジェクトを監視し、状態変化があればコンソールログに表示
function registerPeerConnectionListeners() {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(
        `ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    console.log(
        `ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}

// このJavaScriptで実行するのはinit()関数
init();

