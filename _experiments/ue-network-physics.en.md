---
lang: en
translation_key: "ue-network-physics"
title: "UE5 Network Physics Replication Experiment"
---
How do server correction, client prediction, and interpolation algorithms affect the network synchronization of physics bodies—or rigid bodies—and how do they differ under different network conditions?
Out of curiosity, I prepared a 50-kilogram blue physics cube, one dedicated server, and two clients.
The only variable involved in this experiment is the physics cube. Its movement is driven by three consecutive impulses, applied only on the server at intervals of 2 seconds. The impulse magnitude is fixed, and I trigger it with a command.
I added an automatic recording component to the physics cube. After the game starts, the server and both clients record the cube's position and frame time. I will use these data for analysis.
The experiment is divided into five schemes. The difficulty is divided into two groups.
## Difficulty: Normal
Under normal difficulty, there is no latency or packet-loss simulation.
#### Scheme A: Nothing at All
The first scheme uses none of the methods mentioned above. I disabled position synchronization. The physics cube is simulated entirely by each client.
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

I started the game and applied an impulse to the physics cube on the server. On screen, the physics cubes on both clients did not move at all.
First, look at the position data from all three endpoints. The server cube's position changed, but the clients did not. Of course, this does not meet multiplayer-game requirements.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/normal-a-state.png)
#### Scheme B: Server Authority
In this scheme, I enabled the physics cube's Tick, disabled its movement replication, disabled physics simulation only on the clients, and created a replicated property struct named `ServerState`. Every frame, the server writes the cube's position, rotation, and velocity into `ServerState`. The clients obtain the new values (position and rotation) through an `OnRep` function and assign them to their own physics cubes. In this way, the client physics bodies depend entirely on data sent by the server, with no local simulation or calculation.
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
I started the game and used the command; the impulse launched the physics cube on screen.
Now look at the state data from all three endpoints. This time their states are basically consistent. However, because clients need time to synchronize the server data, there is a positional gap between the clients and server on every frame (the clients update later than the server), and they only catch up after the physics cube stops moving.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/normal-b-state.png)
#### Scheme C: Start Predicting
This group enables client prediction on top of Scheme B. When a client receives new data in OnRep, it also takes the physics cube's velocity and uses it for its own simulation. I think this is a bad approach, because the client receives a historical authoritative state delayed by the network, which may differ from its current predicted state and cause a 'time reversal' effect in which the physics cube jerks backward. I am curious how bad it will be, so let us try it.
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
Unexpectedly, the visuals are actually very smooth, which shows that the clients and server calculate very similar results.
Judging from the state graph, it looks quite similar to Scheme B and even performs a little better. Scheme B's maximum positional error is close to 200 cm, while Scheme C's is around 120 cm. This shows that, in this run, client prediction moved the physics cube in a direction close to the server result before new data arrived, although prediction is not guaranteed to remain correct.
The time-reversal phenomenon does not seem to appear.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/normal-c-state.png)
#### Scheme D: Interpolation
This group modifies Scheme C. When the client's OnRep function receives new data, it does not assign the value directly to the client physics cube, but slowly interpolates toward it. For example, if the server sends a new position of (10,10,10), the client does not immediately Set the position to (10,10,10). Assuming the client cube is currently at (0,0,0) and the interpolation Alpha for this frame is 0.1, it Sets the position to (1,1,1) on the first frame, then continues moving toward the target through Tick.
In this group, when the client's OnRep receives new data, it first assigns it to `TargetState`. Then Tick moves toward this target in small steps.
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
Looking at the position data, Scheme D has the highest positional error among B, C, and D, reaching 300 cm. Compared with Scheme B, consistency between the client-visible state and the authoritative server state has decreased. If the data sent by the server is one large step, the client in this scheme only takes a small step, while predicting by itself at other times, so the error is the largest.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/normal-d-state.png)
#### Scheme E: UE5 Replication
Scheme D is conceptually close to UE5's official physics replication approach. I call this Scheme E. The difference is that Scheme E uses `ReplicateMovement` instead of a replicated struct plus OnRep for synchronization. In addition, when the gap between client and server becomes too large, Scheme E forcibly pulls the client back.
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
The position graph for Scheme E is also the most similar to Scheme D, but Client 1 did not synchronize with the server in the end. Looking at the source code, I found that the difference must exceed 400 cm before a forced pull occurs. The final failure to synchronize may be because the velocity became zero and the body went directly to sleep.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/normal-e-state.png)
#### Normal-Difficulty Summary
The frame times of all five schemes are similar under normal difficulty, so I will only include one graph. Average frame times are all between 10 and 20 ms. Both clients also look very smooth, with no hitches.
![Three-endpoint packet loss and RPC](/assets/experiments/ue-network-physics/dark/normal-summary-network.png)
![Two-client hitch statistics summary](/assets/experiments/ue-network-physics/dark/normal-summary-hitch.png)

---
## Difficulty: Hell
Hell difficulty directly uses Unreal Engine 5's official Bad profile. One-way latency: 100–200 ms, RTT: approximately 200–400 ms, bidirectional packet loss: 5% in each direction.
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
Every scheme is exactly the same as under normal difficulty, so we can look directly at the results.
#### Scheme A: Nothing at All
Under hell difficulty, the packet-loss rate increases. The behavior is the same as under normal difficulty: the clients do not move.
![Three-endpoint packet loss and RPC](/assets/experiments/ue-network-physics/dark/hell-a-network.png)
#### Scheme B: Server Authority
After entering hell mode, there is an obvious stop-and-go feeling, and the maximum positional error is close to 1000 cm. This level of hitching is unacceptable in any multiplayer FPS game, so this primitive scheme is more suitable for board games. It can guarantee absolutely authoritative decisions, and board games take a long time to update new data—placing one piece may take several minutes.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/hell-b-state.png)
![Two-client hitch statistics summary](/assets/experiments/ue-network-physics/dark/hell-b-hitch.png)
#### Scheme C: Start Predicting
This group's visual performance is much smoother than Scheme B. Its maximum positional error is only a little over 800 cm.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/hell-c-state.png)
![Two-client hitch statistics summary](/assets/experiments/ue-network-physics/dark/hell-c-hitch.png)
#### Scheme D: Interpolation
This group feels very smooth and lively, even smoother than Scheme C, just like local simulation. Let us look at the data. The maximum positional error is less than 700 cm.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/hell-d-state.png)
It is the group with the lowest average frame time in hell mode.
![Two-client hitch statistics summary](/assets/experiments/ue-network-physics/dark/hell-d-hitch.png)
#### Scheme E: UE5 Replication
The picture is very smooth. Without saying much more, let us look directly at the data.
![Three-endpoint state comparison](/assets/experiments/ue-network-physics/dark/hell-e-state.png)
#### ![Two-client hitch statistics summary](/assets/experiments/ue-network-physics/dark/hell-e-hitch.png)End
Because the experiment was not repeated enough times, some of the data may be incidental. Even so, it can still support a few conclusions:
1. Client simulation makes the visuals smoother and is necessary for physics bodies in this experiment. Without client-side simulation, the physics body becomes a slideshow under hell mode.
2. Interpolation makes the visuals smoother, but reduces consistency between the client-visible state and the authoritative server state. Error can accumulate more and more, so the catch-up speed must be controlled carefully.
