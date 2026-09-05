---
lang: zh
translation_key: "ue-network-physics"
title: "UE5 网络物理同步实验"
---
服务端校正、客户端预测、插值算法会对物理体，或者说刚体的网络同步造成什么影响，在不同网络情况下有什么区别？
出于好奇，我准备了一个五十公斤的蓝色物理方块、一个独立服务器和两个客户端。
本次实验的有关变量只有物理方块，物理方块的移动依靠三个连续的、间隔2s的、只在服务端执行的冲量推动，冲量的大小是固定的，我通过指令来使用它。
我给物理方块添加了一个自动记录组件。游戏开始后，服务器和两个客户端都会记录物理方块的位置和帧耗时。我会通过这些数据来分析。
实验分为五组。难度分为两组。
## 难度：普通
在普通难度下，没有任何延迟和丢包模拟。
#### 方案A：啥也没有组
第一组不使用以上提到的任何方法，我关掉了位置同步。物理方块完全由客户端自己模拟。
```
ANetworkPhysicsExperimentActor::ANetworkPhysicsExperimentActor()
{
    PrimaryActorTick.bCanEverTick = false;
    bReplicates = false;
    SetReplicateMovement(false);
    bAlwaysRelevant = false;
    MeshComponent->bReplicatePhysicsToAutonomousProxy = false;
}
```

我启动游戏，在服务端对物理方块施加了冲量，画面里两个客户端的物理方块一动不动。
先看三端位置数据。服务端的物理方块位置更新了，但是客户端并没有。这当然不符合多人游戏的要求啦。
![三端状态对比.png](/assets/experiments/ue-network-physics/dark/normal-a-state.png)
#### 方案B：服务器权威组
在这个方案里，我打开了物理方块的Tick，关掉它的移动复制，只在客户端关掉物理模拟，新建一个复制属性结构体`ServerState`，服务端每帧都把物理方块的位置、角度和速度写进`ServerState`，客户端通过`OnRep`函数获取到新值（位置和角度），然后赋值给自己的物理方块。这样一来，客户端的物理体完全依赖服务端传来的数据，没有自己的模拟和计算。
```
ANetworkPhysicsExperimentActor::ANetworkPhysicsExperimentActor()
{
    PrimaryActorTick.bCanEverTick = true;
    bReplicates = true;
    SetReplicateMovement(false);
    bAlwaysRelevant = true;
    MeshComponent->SetIsReplicated(false);
}
void ANetworkPhysicsExperimentActor::BeginPlay()
{
    Super::BeginPlay();
    if (!HasAuthority())
    {
        MeshComponent->SetSimulatePhysics(false);
    }
}
void ANetworkPhysicsExperimentActor::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
    if (GetNetMode() == NM_Client)
    {
        return;
    }
    ServerState.Location = GetActorLocation();
    ServerState.Rotation = GetActorRotation();
    ServerState.LinearVelocity = MeshComponent->GetPhysicsLinearVelocity();
    ServerState.AngularVelocity = MeshComponent->GetPhysicsAngularVelocityInDegrees();
}
void ANetworkPhysicsExperimentActor::OnRep_ServerState()
{
    MeshComponent->SetSimulatePhysics(false);
    SetActorLocationAndRotation(
        ServerState.Location,
        ServerState.Rotation,
        false,
        nullptr,
        ETeleportType::TeleportPhysics);
}
```
我启动游戏使用命令，画面里冲量击飞了物理方块。
来看看三端状态数据。可以看到，这次三端状态基本是一致的，只是由于客户端同步服务端的数据需要一段时间，每一帧客户端和服务端的位置都有一段差距（客户端比服务端更新的慢），直到物理方块停止运动后才追平。
![三端状态对比 1.png](/assets/experiments/ue-network-physics/dark/normal-b-state.png)
#### 方案C：开始预测组
这一组在方案B的基础上打开了客户端预测，并且客户端在OnRep收到新数据的时候，把物理方块的速度也拿过来，用于自己的模拟计算，我觉得这是一个坏做法，因为客户端收到的是经过网络延迟的历史权威状态，可能与客户端当前预测状态产生偏差，出现'时光倒流'情况，物理方块应该会往回卡。我很好奇会有多坏，来试一试。
```
void ANetworkPhysicsExperimentActor::OnRep_ServerState()
{
    MeshComponent->SetSimulatePhysics(true);
    SetActorLocationAndRotation(
        ServerState.Location,
        ServerState.Rotation,
        false,
        nullptr,
        ETeleportType::TeleportPhysics);
    MeshComponent->SetPhysicsLinearVelocity(FVector(ServerState.LinearVelocity));
    MeshComponent->SetPhysicsAngularVelocityInDegrees(FVector(ServerState.AngularVelocity));
}
```
出乎意料的是画面居然非常流畅，说明客户端和服务端的计算的结果很近似。
从状态图来看，和方案B挺相似的，甚至表现更好一点，方案B的最大位置误差接近200cm，但是方案C的最大位置误差在120cm左右。说明在本轮实验中，客户端预测在没有拿到新数据的这段时间里，让物体方块沿着接近服务端结果的方向前进了，但预测不保证始终正确。
时光倒流的现象似乎没有出现...
![三端状态对比 2.png](/assets/experiments/ue-network-physics/dark/normal-c-state.png)
#### 方案D：插值组
这一组在方案C的基础上做出修改，在客户端的OnRep函数收到新的数据时，不是直接赋值给客户端的物理方块，而是慢慢插值过去，比如服务器传来新位置(10,10,10)，客户端不是立刻把位置Set过到(10,10,10)，假设客户端当前的物理方块位置是(0,0,0)，并且这一帧的插值Alpha为0.1，客户端会在第一帧把位置Set到(1,1,1)，后面再通过Tick慢慢移动过去。
在这一组里，当客户端OnRep收到新数据，先把它赋值给`TargetState`存起来。然后在Tick里朝着这个目标小步运动。
```
void ANetworkPhysicsExperimentActor::OnRep_ServerState()
{
    TargetState = ServerState;
    bHasServerTarget = true;
}
void ANetworkPhysicsExperimentActor::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
    const float Alpha = 1.0f - FMath::Exp(-ClientInterpolationSpeed * DeltaTime);
    const FVector SmoothedLocation = FMath::Lerp(GetActorLocation(), FVector(TargetState.Location), Alpha);
    const FQuat SmoothedRotation = FQuat::Slerp(GetActorQuat(),    TargetState.Rotation.Quaternion(),,Alpha).GetNormalized();
     SetActorLocationAndRotation(
            SmoothedLocation,
            SmoothedRotation,
            false,
            nullptr,
            ETeleportType::TeleportPhysics);
        MeshComponent->SetPhysicsLinearVelocity(FMath::Lerp(
        MeshComponent->GetPhysicsLinearVelocity(), FVector(TargetState.LinearVelocity), Alpha));
        MeshComponent->SetPhysicsAngularVelocityInDegrees(FMath::Lerp(
            MeshComponent->GetPhysicsAngularVelocityInDegrees(), FVector(TargetState.AngularVelocity), Alpha));
        return;
    }
}
```
看一下位置数据，位置误差在方案BCD里是最高的，来到了300cm，相比方案B，客户端显示状态与服务端权威状态的一致性下降了，如果说服务端传来的数据是一大步，这个方案的客户端只走了一小步，其他时间都在自己预测，所以误差最大。
![三端状态对比 3.png](/assets/experiments/ue-network-physics/dark/normal-d-state.png)
#### 方案E：UE5复制
方案D和思路上和UE5官方物理复制思路是接近的，我称这个方案为方案E，区别在于方案E使用`ReplicateMovement` 而不是`复制结构体+OnRep`来进行同步，另外方案E在客户端和服务端差距过大的时候，会把客户端强行拉回来。
```
ANetworkPhysicsExperimentActor::ANetworkPhysicsExperimentActor()
{
    PrimaryActorTick.bCanEverTick = false;
    bReplicates = true;
    SetReplicateMovement(true);
    bAlwaysRelevant = true;
    bNetLoadOnClient = true;
    MeshComponent->SetSimulatePhysics(true);
}

void ANetworkPhysicsExperimentActor::BeginPlay()
{
    Super::BeginPlay();
    SetReplicateMovement(true);
    MeshComponent->SetSimulatePhysics(true);
}
```
方案E和方案D的位置图也是最像的，不过客户端1到最后和没有和服务器同步上。看一眼源码发现相差超过400cm才会被强拉，最后没同步可能是速度归零直接睡眠了。
![三端状态对比 4.png](/assets/experiments/ue-network-physics/dark/normal-e-state.png)
#### 普通难度总结
普通难度下的五个方案帧耗时都差不多，我就只放一个图了，平均帧耗时都在10-20ms之间。两个客户端的画面表现也都非常丝滑，没有卡顿。
![三端丢包与RPC 1.png](/assets/experiments/ue-network-physics/dark/normal-summary-network.png)
![双客户端卡顿统计摘要 3.png](/assets/experiments/ue-network-physics/dark/normal-summary-hitch.png)

---
## 难度：地狱
地狱难度直接采用虚幻5官方的Bad配置。单向延迟：100～200 ms，RTT：约 200～400 ms，双向丢包：各 5%。
```
void ANetworkPhysicsExperimentActor::BeginPlay()
{
    Super::BeginPlay();
    if (GetNetMode() == NM_Client)
    {
        GEngine->Exec(GetWorld(), TEXT("NetEmulation.PktEmulationProfile Bad"));
    }
}
```
各个方案和普通难度是一模一样的，所以直接看结果。
#### 方案A：啥也没有组
在地狱难度丢包率上升了，表现和普通难度一样，客户端没有移动。
![三端丢包与RPC.png](/assets/experiments/ue-network-physics/dark/hell-a-network.png)
#### 方案B：服务器权威组
进入地狱模式之后有明显的一顿一顿感，最高位置误差接近1000cm。这种程度的卡顿在任何一个多人FPS游戏里都是不可接受的，所以这种原始的方案比较适合棋类游戏，因为可以保证绝对的权威判决，而且棋类游戏更新一次新数据的时间比较长，可能几分钟才下一颗子。
![三端状态对比 5.png](/assets/experiments/ue-network-physics/dark/hell-b-state.png)
![双客户端卡顿统计摘要 7.png](/assets/experiments/ue-network-physics/dark/hell-b-hitch.png)
#### 方案C：开始预测组
这一组画面表现比方案B要丝滑的多。最大的位置误差也只有800cm+。
![三端状态对比 6.png](/assets/experiments/ue-network-physics/dark/hell-c-state.png)
![双客户端卡顿统计摘要 6.png](/assets/experiments/ue-network-physics/dark/hell-c-hitch.png)
#### 方案D：插值组
这组的表现非常丝滑灵动，比方案C更加流畅，就像在本地模拟一样。来看看数据。最大位置误差只有700cm不到。
![三端状态对比 7.png](/assets/experiments/ue-network-physics/dark/hell-d-state.png)
是地狱模式里平均帧耗时最低的组。
![双客户端卡顿统计摘要 5.png](/assets/experiments/ue-network-physics/dark/hell-d-hitch.png)
#### 方案E：UE5复制
画面非常丝滑不多说，直接看数据。
![三端状态对比 8.png](/assets/experiments/ue-network-physics/dark/hell-e-state.png)
#### ![双客户端卡顿统计摘要 8.png](/assets/experiments/ue-network-physics/dark/hell-e-hitch.png)End
因为实验次数不够多，所以有些数据应该是有偶然性。不过也是能印证一些结论的：
1.客户端模拟让画面更流畅，而且对物理体来说是必须的，如果没有客户端模拟物理体在地狱模式直接卡成PPT了
2.插值让画面更流畅，但是降低了客户端显示状态与服务端权威状态的一致性，误差容易越累加，必须控制好追赶速度
