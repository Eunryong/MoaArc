// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MoaArkTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_PARTICIPANTS = 50;
    uint256 public constant USDC_DECIMALS = 6;
    string public constant VERSION = "MoaArk-1.0";

    enum SettlementStatus {
        None,
        Proposed,
        DeficitPaying,
        ClaimStarted,
        Completed
    }

    struct Trip {
        string name;
        address admin;
        address[] participants;
        uint256 targetBudget;
        bool exists;
        bool locked;
        SettlementStatus settlementStatus;
        uint256 settlementVersion;
        bytes32 pendingSettlementHash;
        address[] settlementMembers;
        uint256[] finalRefundAmounts;
        uint256[] requiredDeficits;
    }

    error TripNotFound(uint256 tripId);
    error NotAdmin(uint256 tripId);
    error NotParticipant(uint256 tripId);
    error AlreadyParticipant(address addr);
    error InvalidAmount();
    error InsufficientContractBalance(uint256 available, uint256 requested);
    error ExceedsAllocated(uint256 allocated, uint256 requested);
    error ExceedsRequiredDeficit(uint256 required, uint256 paid, uint256 attempted);
    error SettlementHashMismatch(bytes32 expected, bytes32 provided);
    error NotAllApproved();
    error DeficitNotFullyPaid();
    error BalanceMismatch(uint256 contractBalance, uint256 expectedForRefunds);
    error AlreadyClaimed();
    error NoSettlementProposed();
    error ArrayLengthMismatch();
    error ZeroAddress();
    error InvalidSettlementMembers();
    error SpenderNotParticipant(address spender);
    error TooManyParticipants(uint256 max, uint256 provided);
    error TripLocked(uint256 tripId);
    error SettlementAlreadyInProgress(SettlementStatus current);
    error SettlementVersionMismatch(uint256 expected, uint256 provided);
    error ExceedsAllocatedBudget(uint256 allocated, uint256 spent, uint256 attempted);
    error InvalidSettlementHash(bytes32 expected, bytes32 provided);
    error SpendAmountExceedsAllocated(uint256 allocated, uint256 alreadySpent, uint256 requested);

    event TripCreated(uint256 indexed tripId, address indexed admin, string name, uint256 targetBudget);
    event Deposited(uint256 indexed tripId, address indexed participant, uint256 amount);
    event BudgetReleased(uint256 indexed tripId, address indexed spender, uint256 amount, string memo);
    event BudgetReturned(uint256 indexed tripId, address indexed returner, uint256 amount);
    event DeficitPaid(uint256 indexed tripId, address indexed payer, uint256 amount);
    event SettlementProposed(
        uint256 indexed tripId,
        bytes32 indexed ledgerHash,
        address[] members,
        uint256[] refundAmounts,
        uint256[] requiredDeficits
    );
    event SettlementApproved(uint256 indexed tripId, address indexed participant, bytes32 indexed ledgerHash);
    event RefundClaimed(uint256 indexed tripId, address indexed participant, uint256 amount);
    event ActualSpendRecorded(uint256 indexed tripId, address indexed spender, uint256 amount, string memo);
    event PersonalPrepaidRecorded(uint256 indexed tripId, address indexed payer, uint256 amount, string memo);
    event SettlementLocked(uint256 indexed tripId, SettlementStatus status);
    event TripCompleted(uint256 indexed tripId);
    event VersionInfo(string version);

    mapping(uint256 => Trip) public trips;
    mapping(uint256 => mapping(address => uint256)) public depositedAmount;
    mapping(uint256 => mapping(address => uint256)) public allocatedBudget;
    mapping(uint256 => mapping(address => uint256)) public spentFromBudget;
    mapping(uint256 => mapping(address => uint256)) public personalPrepaid;
    mapping(uint256 => mapping(address => bool)) public settlementApproved;
    mapping(uint256 => mapping(address => uint256)) public paidDeficit;
    mapping(uint256 => mapping(address => bool)) public refundClaimed;
    mapping(uint256 => mapping(address => bool)) public isParticipant;
    mapping(uint256 => uint256) public tripBalance;
    mapping(uint256 => uint256) public settlementTotalRefunds;
    mapping(uint256 => uint256) public claimCount;

    uint256 public tripCount;
    IERC20 public immutable usdc;

    constructor(address usdcToken) {
        if (usdcToken == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);
        emit VersionInfo(VERSION);
    }

    modifier tripExists(uint256 tripId) {
        if (!trips[tripId].exists) revert TripNotFound(tripId);
        _;
    }

    modifier onlyAdmin(uint256 tripId) {
        if (msg.sender != trips[tripId].admin) revert NotAdmin(tripId);
        _;
    }

    modifier onlyParticipant(uint256 tripId) {
        if (!isParticipant[tripId][msg.sender]) revert NotParticipant(tripId);
        _;
    }

    function createTrip(
        string calldata name,
        address[] calldata participants,
        uint256 targetBudget
    ) external returns (uint256 tripId) {
        uint256 providedParticipants = participants.length + 1;
        if (providedParticipants > MAX_PARTICIPANTS) {
            revert TooManyParticipants(MAX_PARTICIPANTS, providedParticipants);
        }

        tripCount += 1;
        tripId = tripCount;

        Trip storage trip = trips[tripId];
        trip.name = name;
        trip.admin = msg.sender;
        trip.targetBudget = targetBudget;
        trip.exists = true;

        isParticipant[tripId][msg.sender] = true;
        trip.participants.push(msg.sender);

        uint256 participantsLength = participants.length;
        for (uint256 i = 0; i < participantsLength; i++) {
            address participant = participants[i];
            if (participant == address(0)) revert ZeroAddress();
            if (isParticipant[tripId][participant]) revert AlreadyParticipant(participant);

            isParticipant[tripId][participant] = true;
            trip.participants.push(participant);
        }

        emit TripCreated(tripId, msg.sender, name, targetBudget);
    }

    function deposit(uint256 tripId, uint256 amount)
        external
        nonReentrant
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        if (trips[tripId].locked) revert TripLocked(tripId);
        // Also block deposits once deficit-paying or claim phase started (balance mutation would break solvency check)
        SettlementStatus depositStatus = trips[tripId].settlementStatus;
        if (depositStatus == SettlementStatus.DeficitPaying ||
            depositStatus == SettlementStatus.ClaimStarted ||
            depositStatus == SettlementStatus.Completed) {
            revert SettlementAlreadyInProgress(depositStatus);
        }
        if (amount == 0) revert InvalidAmount();

        depositedAmount[tripId][msg.sender] += amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(tripId, msg.sender, amount);
    }

    function releaseBudget(uint256 tripId, address spender, uint256 amount, string calldata memo)
        external
        nonReentrant
        tripExists(tripId)
        onlyAdmin(tripId)
    {
        if (trips[tripId].locked) revert TripLocked(tripId);
        if (spender == address(0)) revert ZeroAddress();
        if (!isParticipant[tripId][spender]) revert SpenderNotParticipant(spender);
        if (amount == 0) revert InvalidAmount();

        uint256 availableBalance = tripBalance[tripId];
        if (availableBalance < amount) revert InsufficientContractBalance(availableBalance, amount);

        allocatedBudget[tripId][spender] += amount;
        tripBalance[tripId] = availableBalance - amount;
        usdc.safeTransfer(spender, amount);

        emit BudgetReleased(tripId, spender, amount, memo);
    }

    function returnUnusedBudget(uint256 tripId, uint256 amount) external nonReentrant tripExists(tripId) {
        if (amount == 0) revert InvalidAmount();
        // Block balance mutation once claim phase has started (would break the solvency check)
        SettlementStatus status = trips[tripId].settlementStatus;
        if (status == SettlementStatus.ClaimStarted || status == SettlementStatus.Completed) {
            revert SettlementAlreadyInProgress(status);
        }

        uint256 allocated = allocatedBudget[tripId][msg.sender];
        if (amount > allocated) revert ExceedsAllocated(allocated, amount);

        allocatedBudget[tripId][msg.sender] = allocated - amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit BudgetReturned(tripId, msg.sender, amount);
    }

    function recordActualSpend(uint256 tripId, uint256 amount, string calldata memo)
        external
        nonReentrant
        tripExists(tripId)
    {
        if (amount == 0) revert InvalidAmount();

        uint256 allocated = allocatedBudget[tripId][msg.sender];
        uint256 alreadySpent = spentFromBudget[tripId][msg.sender];
        if (alreadySpent + amount > allocated) {
            revert SpendAmountExceedsAllocated(allocated, alreadySpent, amount);
        }

        spentFromBudget[tripId][msg.sender] = alreadySpent + amount;

        emit ActualSpendRecorded(tripId, msg.sender, amount, memo);
    }

    function recordPersonalPrepaid(uint256 tripId, uint256 amount, string calldata memo)
        external
        nonReentrant
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        if (trips[tripId].locked) revert TripLocked(tripId);
        if (amount == 0) revert InvalidAmount();

        personalPrepaid[tripId][msg.sender] += amount;

        emit PersonalPrepaidRecorded(tripId, msg.sender, amount, memo);
    }

    function payDeficit(uint256 tripId, uint256 amount)
        external
        nonReentrant
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        if (amount == 0) revert InvalidAmount();

        Trip storage trip = trips[tripId];
        if (trip.settlementStatus == SettlementStatus.None) revert NoSettlementProposed();
        if (trip.settlementStatus == SettlementStatus.ClaimStarted || trip.settlementStatus == SettlementStatus.Completed) {
            revert SettlementAlreadyInProgress(trip.settlementStatus);
        }

        (uint256 index, bool found) = _findSettlementMemberIndex(trip, msg.sender);
        if (!found) revert NotParticipant(tripId);

        uint256 required = trip.requiredDeficits[index];
        uint256 paid = paidDeficit[tripId][msg.sender];

        if (paid + amount > required) {
            revert ExceedsRequiredDeficit(required, paid, amount);
        }

        paidDeficit[tripId][msg.sender] = paid + amount;
        tripBalance[tripId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        if (trip.settlementStatus == SettlementStatus.Proposed) {
            trip.settlementStatus = SettlementStatus.DeficitPaying;
            emit SettlementLocked(tripId, SettlementStatus.DeficitPaying);
        }

        emit DeficitPaid(tripId, msg.sender, amount);
    }

    function proposeFinalSettlement(
        uint256 tripId,
        address[] calldata members,
        uint256[] calldata finalRefundAmounts,
        uint256[] calldata requiredDeficits
    ) external tripExists(tripId) onlyAdmin(tripId) {
        if (members.length != finalRefundAmounts.length || members.length != requiredDeficits.length) {
            revert ArrayLengthMismatch();
        }

        Trip storage trip = trips[tripId];
        if (trip.settlementStatus >= SettlementStatus.DeficitPaying) {
            revert SettlementAlreadyInProgress(trip.settlementStatus);
        }

        if (members.length != trip.participants.length) {
            revert ArrayLengthMismatch();
        }

        _validateSettlementMembers(tripId, trip, members);

        uint256 newVersion = trip.settlementVersion + 1;
        bytes32 derivedHash = keccak256(abi.encode(tripId, newVersion, members, finalRefundAmounts, requiredDeficits));

        trip.pendingSettlementHash = derivedHash;
        trip.settlementMembers = members;
        trip.finalRefundAmounts = finalRefundAmounts;
        trip.requiredDeficits = requiredDeficits;
        trip.settlementVersion = newVersion;
        trip.settlementStatus = SettlementStatus.Proposed;

        uint256 membersLength = members.length;
        uint256 totalRefunds = 0;
        for (uint256 i = 0; i < membersLength; i++) {
            totalRefunds += finalRefundAmounts[i];
            settlementApproved[tripId][members[i]] = false;
            refundClaimed[tripId][members[i]] = false;
            paidDeficit[tripId][members[i]] = 0;
        }

        settlementTotalRefunds[tripId] = totalRefunds;
        claimCount[tripId] = 0;

        emit SettlementProposed(tripId, derivedHash, members, finalRefundAmounts, requiredDeficits);
    }

    function approveFinalSettlement(uint256 tripId, bytes32 ledgerHash)
        external
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        Trip storage trip = trips[tripId];
        if (trip.settlementStatus == SettlementStatus.None) revert NoSettlementProposed();
        if (ledgerHash != trip.pendingSettlementHash) {
            revert InvalidSettlementHash(trip.pendingSettlementHash, ledgerHash);
        }

        settlementApproved[tripId][msg.sender] = true;

        emit SettlementApproved(tripId, msg.sender, ledgerHash);
    }

    function claimRefund(uint256 tripId)
        external
        nonReentrant
        tripExists(tripId)
        onlyParticipant(tripId)
    {
        Trip storage trip = trips[tripId];
        if (trip.locked) revert TripLocked(tripId);
        if (trip.settlementStatus == SettlementStatus.None) revert NoSettlementProposed();
        if (refundClaimed[tripId][msg.sender]) revert AlreadyClaimed();

        address[] storage members = trip.settlementMembers;
        uint256[] storage refunds = trip.finalRefundAmounts;
        uint256[] storage deficits = trip.requiredDeficits;
        uint256 membersLength = members.length;

        for (uint256 i = 0; i < membersLength; i++) {
            address member = members[i];
            if (!settlementApproved[tripId][member]) revert NotAllApproved();
            if (paidDeficit[tripId][member] != deficits[i]) revert DeficitNotFullyPaid();
        }

        if (claimCount[tripId] == 0) {
            uint256 availableBalance = tripBalance[tripId];
            uint256 totalRefunds = settlementTotalRefunds[tripId];
            if (availableBalance != totalRefunds) {
                revert BalanceMismatch(availableBalance, totalRefunds);
            }
            trip.settlementStatus = SettlementStatus.ClaimStarted;
            emit SettlementLocked(tripId, SettlementStatus.ClaimStarted);
        }

        (uint256 index, bool found) = _findSettlementMemberIndex(trip, msg.sender);
        if (!found) revert NotParticipant(tripId);

        uint256 refundAmount = refunds[index];
        refundClaimed[tripId][msg.sender] = true;
        claimCount[tripId] += 1;
        if (refundAmount > 0) {
            tripBalance[tripId] -= refundAmount;
        }

        if (refundAmount > 0) {
            usdc.safeTransfer(msg.sender, refundAmount);
        }

        emit RefundClaimed(tripId, msg.sender, refundAmount);

        if (claimCount[tripId] == membersLength) {
            trip.locked = true;
            trip.settlementStatus = SettlementStatus.Completed;
            emit TripCompleted(tripId);
        }
    }

    function getTrip(uint256 tripId) external view tripExists(tripId) returns (Trip memory) {
        return trips[tripId];
    }

    function getTripParticipants(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (address[] memory)
    {
        return trips[tripId].participants;
    }

    function getSettlementMembers(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (address[] memory)
    {
        return trips[tripId].settlementMembers;
    }

    function getSettlementDetails(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (
            bytes32 hash,
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits,
            bool proposed
        )
    {
        Trip storage trip = trips[tripId];
        return (
            trip.pendingSettlementHash,
            trip.settlementMembers,
            trip.finalRefundAmounts,
            trip.requiredDeficits,
            trip.settlementStatus != SettlementStatus.None
        );
    }

    function isAllApproved(uint256 tripId) external view tripExists(tripId) returns (bool) {
        Trip storage trip = trips[tripId];
        if (trip.settlementStatus == SettlementStatus.None) return false;

        uint256 membersLength = trip.settlementMembers.length;
        for (uint256 i = 0; i < membersLength; i++) {
            if (!settlementApproved[tripId][trip.settlementMembers[i]]) {
                return false;
            }
        }

        return true;
    }

    function isAllDeficitPaid(uint256 tripId) external view tripExists(tripId) returns (bool) {
        Trip storage trip = trips[tripId];
        if (trip.settlementStatus == SettlementStatus.None) return false;

        uint256 membersLength = trip.settlementMembers.length;
        for (uint256 i = 0; i < membersLength; i++) {
            address member = trip.settlementMembers[i];
            if (paidDeficit[tripId][member] != trip.requiredDeficits[i]) {
                return false;
            }
        }

        return true;
    }

    function getContractBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function getParticipantSettlementIndex(uint256 tripId, address participant)
        external
        view
        tripExists(tripId)
        returns (uint256 index, bool found)
    {
        Trip storage trip = trips[tripId];
        return _findSettlementMemberIndex(trip, participant);
    }

    function getSpentFromBudget(uint256 tripId, address spender) external view returns (uint256) {
        return spentFromBudget[tripId][spender];
    }

    function getPersonalPrepaid(uint256 tripId, address payer) external view returns (uint256) {
        return personalPrepaid[tripId][payer];
    }

    function getSettlementStatus(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (SettlementStatus)
    {
        return trips[tripId].settlementStatus;
    }

    function getSettlementVersion(uint256 tripId)
        external
        view
        tripExists(tripId)
        returns (uint256)
    {
        return trips[tripId].settlementVersion;
    }

    function computeSettlementHash(
        uint256 tripId,
        uint256 version,
        address[] calldata members,
        uint256[] calldata finalRefundAmounts,
        uint256[] calldata requiredDeficits
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(tripId, version, members, finalRefundAmounts, requiredDeficits));
    }

    function _findSettlementMemberIndex(Trip storage trip, address participant)
        internal
        view
        returns (uint256 index, bool found)
    {
        uint256 membersLength = trip.settlementMembers.length;
        for (uint256 i = 0; i < membersLength; i++) {
            if (trip.settlementMembers[i] == participant) {
                return (i, true);
            }
        }

        return (0, false);
    }

    function _validateSettlementMembers(uint256 tripId, Trip storage trip, address[] calldata members) internal view {
        uint256 membersLength = members.length;
        for (uint256 i = 0; i < membersLength; i++) {
            address member = members[i];
            if (member == address(0)) revert ZeroAddress();
            if (!isParticipant[tripId][member]) revert NotParticipant(tripId);
        }

        uint256 participantsLength = trip.participants.length;
        for (uint256 i = 0; i < participantsLength; i++) {
            address participant = trip.participants[i];
            uint256 occurrences = 0;

            for (uint256 j = 0; j < membersLength; j++) {
                if (members[j] == participant) {
                    occurrences += 1;
                }
            }

            if (occurrences != 1) revert InvalidSettlementMembers();
        }
    }
}
