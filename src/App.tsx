import {useCallback, useEffect, useMemo, useState} from 'react'
import { nanoid } from 'nanoid'
import './index.css'
import {useDropzone} from "react-dropzone";
import {io} from "socket.io-client";
import PromiseQueue from "./PromiseQueue.ts";

const signalingServerUrl = 'https://api-server-3.goaffpro.com:3001';
const config = { iceServers: [
    {
        urls: 'stun:stun.l.google.com:19302'
    },
] };
const peerConnections: Record<string, RTCPeerConnection> = {};
const dataChannels: Record<string, RTCDataChannel> = {};
const socket = io(signalingServerUrl,{
    autoConnect:false
});
const queue = new PromiseQueue(1)
const type = "sender";

function App(){
    const room = useMemo(()=>{
       return     document.location.hash ? document.location.hash.substring(1) : nanoid()
    },[])
    if(room !== document.location.hash?.substring(1)) {
        document.location.hash = room;
    }
    return <InternalApp room={room}/>
}

function InternalApp({room}:{room: string}) {
    const [connectedPeers, setConnectedPeers] = useState<{peerId: string, username: string}[]>([])

    useEffect(() => {
        if(!type){
            return
        }
        console.log('use effect called')
       async function onConnect() {
            socket.emit('join', {room, username: 'sender'});
            // setSocketId(socket.id)
        }
        function onDisconnect() {
            // setIsConnected(false);
        }

        function onPeerConnected({peerId, username}:{username: string;peerId: string}){
            if(username !== "sender") {
                queue.enqueue(() => createPeerConnection({peerId, username}, type === "sender"))
            }
        }

        async function onSignal({peerId, payload}:{
            peerId: string,
            payload: string
        }) {
           return queue.enqueue(async ()=> {
               console.log(peerConnections[peerId].signalingState)
               const data = JSON.parse(payload);
               if (data.type === "offer") {
                   console.log('remote set')
                   await peerConnections[peerId].setRemoteDescription(data.offer);
                   console.log('create answer')
                   const answer = await peerConnections[peerId].createAnswer();
                   // console.log('set local')
                   await peerConnections[peerId].setLocalDescription(answer);
                   socket.emit('signal', {
                       room: room,
                       targetPeerId: peerId,
                       payload: JSON.stringify({type: 'answer',
                          answer:peerConnections[peerId].localDescription
                       })
                   });
               }
               if (data.type === 'answer') {
                   await peerConnections[peerId].setRemoteDescription(data.answer)
               } else if (data.type === 'candidate') {
                   await peerConnections[peerId].addIceCandidate(new RTCIceCandidate(data.candidate));
               }
               // console.log(data.type,' set', peerId)
           })
        }
        async function onPeerDisconnected({peerId}:{peerId: string}){
            if (peerConnections[peerId]) {
                peerConnections[peerId].close();
                delete peerConnections[peerId];
                delete dataChannels[peerId];
            }
        }
        async function createPeerConnection({peerId, username}:{peerId: string, username: string}, initiator = false) {
            console.log('creating peer connection', peerId, initiator)
            peerConnections[peerId] = new RTCPeerConnection(config);
            // peerConnections[peerId].onsignalingstatechange = (event) => {
            //     console.log('signaling state change', peerConnections[peerId].signalingState)
            // }
            // peerConnections[peerId].oniceconnectionstatechange = (event) => {
            //     console.log('ice connection state change', peerConnections[peerId].iceConnectionState)
            // }
            // peerConnections[peerId].onicegatheringstatechange = (event) => {
            //     console.log('ice gathering state change', peerConnections[peerId].iceGatheringState)
            // }
            // peerConnections[peerId].onconnectionstatechange = (event) => {
            //     console.log('connection state change', peerConnections[peerId].connectionState)
            // }
            peerConnections[peerId].onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit('signal', { room, targetPeerId: peerId, payload: JSON.stringify({ type: 'candidate', candidate: event.candidate }) });
                }
            };

            peerConnections[peerId].ondatachannel = (event) => {
                console.log('datachannel created')
                const receiveChannel = event.channel;
                dataChannels[peerId] = receiveChannel;
                console.log('receive channel created', receiveChannel.label)
                receiveChannel.onerror = (error) => console.error('Data channel error', error);
                receiveChannel.onclose = () => console.log('Data channel closed with', peerId);
                let chunks: ArrayBuffer[] = [];
                receiveChannel.onmessage = (event) => {
                    console.log('message received in channel', event)
                    const arrayBuffer = event.data;
                    if(event.data === "end"){
                        const blob = new Blob(chunks);
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'file';
                        a.click();
                        chunks = []
                        console.log(url)
                        return
                    }else{
                        chunks.push(arrayBuffer)
                    }
                };
            };
            console.log('is initiator', initiator)

            if (initiator) {

                const dataChannel =  peerConnections[peerId].createDataChannel('fileTransfer');
                dataChannels[peerId] = dataChannel;
                dataChannel.onopen = () => {
                    console.log('Data channel open with', peerId);
                    setConnectedPeers((connectedPeers)=>[...connectedPeers, {peerId, username}])
                }
                dataChannel.onclose = () => {
                    setConnectedPeers((connectedPeers)=>{
                        return connectedPeers.filter((p)=>p.peerId !== peerId)
                    })
                    console.log('Data channel closed with', peerId);
                }
                dataChannel.onerror = (error) => console.error('Data channel error', error);
                const offer = await  peerConnections[peerId].createOffer();
                console.log('offer created')
                await  peerConnections[peerId].setLocalDescription(offer);
                console.log('local description set')
                socket.emit('signal', { room, targetPeerId: peerId, payload: JSON.stringify({ type: 'offer', offer:  peerConnections[peerId].localDescription }) });
            }
            // console.log('peer connection created')
        }
        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on('signal', onSignal);
        socket.on('peer-disconnected', onPeerDisconnected)
        socket.on('new-peer', onPeerConnected)
        socket.connect();
        return () => {
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
            socket.off('signal', onSignal);
            socket.off('new-peer', onPeerConnected)
            socket.on('peer-disconnected', onPeerDisconnected)
        };
    }, [room]);

    // const [progress, setProgress] = useState(0)
    const [files, setFiles] = useState<{file: File, progress:number, size:number}[]>([])
    const onDrop = useCallback(async (acceptedFiles: File[]) => {
        setFiles(acceptedFiles.map((i)=>{
            return {
                file: i,
                progress: 0,
                size:0,
            }
        }))
        for(const file of acceptedFiles) {
            if (file) {
                await new Promise<void>((resolve)=>{
                const CHUNK_SIZE = 16384;  // 16 KB
                const reader = new FileReader();
                let offset = 0;
                const sendToDataChannels = (arrayBuffer: ArrayBuffer | string) => {
                    Object.values(dataChannels).forEach(channel => {
                        if (channel.readyState !== 'open') {
                            return;
                        }
                        setFiles((files)=>{
                            return files.map((i)=>{
                                if(i.file === file){
                                    return {
                                        ...i,
                                        size: file.size,
                                        progress: Math.min(offset, file.size)
                                    }
                                }
                                return i
                            })
                        })
                        console.log('sending', arrayBuffer)
                        channel.send(arrayBuffer as ArrayBuffer);
                        if (offset < file.size) {
                            readSlice(offset);
                        } else {
                            channel.send('end');
                            resolve()
                        }
                    });
                }
                reader.onload = (e) => {
                    const arrayBuffer = e.target?.result;
                    if (arrayBuffer) {
                        sendToDataChannels(arrayBuffer);
                    }
                };

                const readSlice = (o: number) => {
                    const slice = file.slice(offset, o + CHUNK_SIZE);
                    reader.readAsArrayBuffer(slice);
                    offset += CHUNK_SIZE;
                };
                setFiles((files)=>{
                    return files.map((i)=>{
                        if(i.file === file){
                            return {
                                ...i,
                                size: file.size
                            }
                        }
                        return i
                    })
                })
                // first chunk is JSON of file info
                sendToDataChannels(`metadata://${JSON.stringify({
                    name: file.name,
                    size: file.size,
                    type: file.type,
                })}`);

                })

                // readSlice(0);
                console.log('sending file...')
            } else {
                console.log('Please select a file.');
            }
        }
        // Do something with the files
    }, [])
    const {getRootProps, getInputProps, isDragActive} = useDropzone({
        onDrop,
        multiple: true,
        accept: {
            'image/*':['.png','.jpg','.jpeg','.gif','.webp'],
            'video/*':['.mp4','.webm','.mov'],
        },
    });
    const [showQr, setShowQr] = useState(false)
  return (
    <div className={"bg-gray-200 min-h-screen"}>
        <div className="container mx-auto px-4 pt-4">
            <div style={{maxWidth: 400}} className={"mx-auto"}>
                <div className="flex justify-between">
                    <h1 className={"text-3xl"}>Send <small className={"text-lg text-gray-700"}>by Audio Manager</small></h1>
                    <span><img src={"/android-chrome-192x192.png"}
                               className={"squircle"}
                               style={{width:64, height:64}} /></span>
                </div>
                <hr className={"border-b py-2 mb-4 border-b-gray-300"}/>
                <div className="flex justify-between">
                    <div>
                        <h2 className={"text-2xl"}>Step 1</h2>
                        <p>Scan the QR Code in the app</p>
                    </div>
                    {
                        connectedPeers.length > 0 ?
                    <img
                        onClick={()=>setShowQr((x)=>!x)}
                        style={{width:54, height:54}}
                        src={`https://custom-api.goaffpro.com/qrcode?content=hiprtc://${room}&size=400&margin=1`}
                        alt=""/> : null
                    }
            </div>
            <div className="border rounded bg-white p-2 shadow">
                {
                    showQr || connectedPeers.length === 0 ? <>
                    <img
                        src={`https://custom-api.goaffpro.com/qrcode?content=hiprtc://${room}&size=400&margin=1`}
                        alt=""/>
                            </> : null
                    }
                    {
                        connectedPeers.length === 0 ? <p className={"text-center animate-bounce"}>
                           Waiting for clients to connect
                        </p> : <div>
                            Connected clients
                            <ul>
                                {
                                    connectedPeers.map((i)=>{
                                        return <li key={String(i.peerId)} className={"flex items-center gap-2"}>
                                            <span className="relative flex h-3 w-3">
                                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                                              <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500"></span>
                                            </span>
                                        <span className={"text-sky-500"}>{i.username}</span></li>
                                    })
                                }
                            </ul>
                        </div>
                    }
                </div>
                <div className="mt-6">
                {
                    connectedPeers.length > 0 ? <>
                <h2 className={"text-2xl"}>Step 2</h2>
                <p>Choose the documents that you want to send to your device below</p>
                    <div className={"bg-white shadow rounded border"}>
                        <div {...getRootProps()}
                             className={"h-48 flex rounded items-center justify-center"}>
                            <input {...getInputProps()} />
                            {
                                isDragActive ?
                                    <p>Drop the files here ...</p> :
                                    <p>Drag 'n' drop some files here, or click to select files</p>
                            }
                        </div>
                        {
                            files.map((i) => {
                                const percentage =(i.size > 0 ? i.progress/i.size : 0) * 100
                                return <div className={`mb-4 px-2 pt-2 border-t flex items-center justify-between ${percentage === 100 ? 'text-green-700' : ''}`}>
                                    <span>
                                        {i.file.name}
                                    </span>
                                    <span>
                                        {
                                            percentage === 100 ? '✅︎' :   <>{percentage}%</>
                                        }
                                    </span>
                                </div>
                            })
                        }
                        {
                            files.length > 0 ? <button
                                onClick={()=>setFiles((files)=>files.filter((i)=>i.progress !== i.size))}
                                className={"text-sky-500 flex w-full justify-center items-center p-2"}>Clear list</button> : null
                        }
                    </div>
                    </> : null
                }
                </div>
            </div>
        </div>
    </div>
  )
}

export default App
