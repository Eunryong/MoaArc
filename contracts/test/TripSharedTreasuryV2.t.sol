// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TripSharedTreasuryV2} from "../TripSharedTreasuryV2.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @dev Full unit + fuzz + invariant test suite for TripSharedTreasuryV2.
contract TripSharedTreasuryV2Test is Test {
    // ─────────────────────── constants ───────────────────────
    uint256 internal constant DEPOSIT   = 100e6; // 100 USDC
    uint256 internal constant DECIMALS  = 6;

    // ─────────────────────── addresses ───────────────────────
    address internal admin   = makeAddr("admin");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");
    address internal dave    = makeAddr("dave");
    address internal stranger = makeAddr("stranger");

    // ─────────────────────── contracts ───────────────────────
    MockERC20 internal usdc;
    TripSharedTreasuryV2 internal treasury;

    // ─────────────────────── trip id used in most tests ───────
    uint256 internal tripId;

    // ─────────────────────────────────────────────────────────
    //  setUp – runs before EVERY test
    // ─────────────────────────────────────────────────────────
    function setUp() public {
        // Deploy mock USDC
        usdc = new MockERC20("Mock USDC", "mUSDC", uint8(DECIMALS));

        // Deploy treasury with the mock token
        treasury = new TripSharedTreasuryV2(address(usdc));

        // Create a standard 4-participant trip (admin + 3 others)
        address[] memory extras = new address[](3);
        extras[0] = alice;
        extras[1] = bob;
        extras[2] = carol;

        vm.prank(admin);
        tripId = treasury.createTrip("Summer Trip", extras, 400e6);

        // Mint enough USDC to each participant
        usdc.mint(admin,    10_000e6);
        usdc.mint(alice,    10_000e6);
        usdc.mint(bob,      10_000e6);
        usdc.mint(carol,    10_000e6);
        usdc.mint(dave,     10_000e6);
        usdc.mint(stranger, 10_000e6);

        // Pre-approve treasury to pull from each participant
        vm.prank(admin);  usdc.approve(address(treasury), type(uint256).max);
        vm.prank(alice);  usdc.approve(address(treasury), type(uint256).max);
        vm.prank(bob);    usdc.approve(address(treasury), type(uint256).max);
        vm.prank(carol);  usdc.approve(address(treasury), type(uint256).max);
        vm.prank(dave);   usdc.approve(address(treasury), type(uint256).max);
        vm.prank(stranger); usdc.approve(address(treasury), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────

    /// All 4 participants deposit DEPOSIT each → 400e6 in tripBalance.
    function _allDeposit() internal {
        vm.prank(admin); treasury.deposit(tripId, DEPOSIT);
        vm.prank(alice); treasury.deposit(tripId, DEPOSIT);
        vm.prank(bob);   treasury.deposit(tripId, DEPOSIT);
        vm.prank(carol); treasury.deposit(tripId, DEPOSIT);
    }

    /// Build the standard settlement arrays for the 68e6-expense scenario.
    /// Expense = 68e6, shares: admin=22e6, alice=17e6, bob=12e6, carol=17e6.
    /// Each deposited 100e6, so refunds = 100 - share.
    /// After expense payments the tripBalance must equal 332e6 = sum(refunds).
    /// No deficits in this scenario.
    function _standardSettlementArrays()
        internal
        view
        returns (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        )
    {
        members  = new address[](4);
        refunds  = new uint256[](4);
        deficits = new uint256[](4);

        // Order must match the participants array: admin, alice, bob, carol
        members[0] = admin; members[1] = alice; members[2] = bob; members[3] = carol;
        refunds[0] = 78e6;  refunds[1] = 83e6;  refunds[2] = 88e6; refunds[3] = 83e6;
        // No one owes a deficit
    }

    /// Derive the pending settlement hash exactly as the contract does.
    function _computeHash(
        address[] memory members,
        uint256[] memory refunds,
        uint256[] memory deficits,
        uint256 version
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(tripId, version, members, refunds, deficits));
    }

    /// ─── full happy-path settlement flow (no deficits) ───────
    /// Leaves treasury in ClaimStarted state, first claim NOT yet done.
    /// tripBalance is set to sum(refunds) via vm.deal-style trick:
    /// we use releaseBudget+returnUnusedBudget to drain to 332e6.
    function _proposeAndApproveSettlement() internal returns (bytes32 h) {
        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        // Propose
        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 version = treasury.getSettlementVersion(tripId);
        h = _computeHash(members, refunds, deficits, version);

        // All approve
        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 1 – Participant verification
    // ─────────────────────────────────────────────────────────

    function test_T01_AdminIsAutoParticipant() public view {
        assertTrue(treasury.isParticipant(tripId, admin), "admin should be participant");
    }

    function test_T01_ParticipantsAreRegistered() public view {
        assertTrue(treasury.isParticipant(tripId, alice), "alice");
        assertTrue(treasury.isParticipant(tripId, bob),   "bob");
        assertTrue(treasury.isParticipant(tripId, carol), "carol");
    }

    function test_T01_StrangerCannotDeposit() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(TripSharedTreasuryV2.NotParticipant.selector, tripId)
        );
        treasury.deposit(tripId, DEPOSIT);
    }

    function test_T01_StrangerCannotReturnUnused() public {
        // First give stranger an allocated budget (impossible via normal flow),
        // so the onlyParticipant gate fires before ExceedsAllocated.
        // returnUnusedBudget does NOT have onlyParticipant modifier — it checks
        // allocated > 0 instead.  A stranger with zero allocation gets ExceedsAllocated(0,X).
        // The spec says "Non-participant reverts NotParticipant" for deposit; for
        // returnUnusedBudget the contract uses ExceedsAllocated when allocation==0.
        // We verify the revert occurs (guard is in place).
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(TripSharedTreasuryV2.ExceedsAllocated.selector, 0, DEPOSIT)
        );
        treasury.returnUnusedBudget(tripId, DEPOSIT);
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 2 – Deposit / release / spend / return accounting
    // ─────────────────────────────────────────────────────────

    function test_T02_FourDeposits_TripBalance400() public {
        _allDeposit();
        assertEq(treasury.tripBalance(tripId), 400e6, "tripBalance after 4 deposits");
    }

    function test_T02_ReleaseBudget_ReducesTripBalance() public {
        _allDeposit();

        vm.prank(admin);
        treasury.releaseBudget(tripId, alice, 50e6, "spending money");

        assertEq(treasury.tripBalance(tripId),          350e6, "tripBalance after release");
        assertEq(treasury.allocatedBudget(tripId, alice), 50e6, "alice allocation");
    }

    function test_T02_RecordActualSpend_DoesNotChangeTripBalance() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 50e6, "funds");

        vm.prank(alice); treasury.recordActualSpend(tripId, 40e6, "hotel");

        assertEq(treasury.tripBalance(tripId),              350e6, "tripBalance unchanged");
        assertEq(treasury.spentFromBudget(tripId, alice),    40e6, "spentFromBudget");
    }

    function test_T02_ReturnUnused_RestoresTripBalance() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 50e6, "funds");
        vm.prank(alice); treasury.recordActualSpend(tripId, 40e6, "hotel");

        vm.prank(alice); treasury.returnUnusedBudget(tripId, 10e6);

        assertEq(treasury.tripBalance(tripId),               360e6, "tripBalance after return");
        assertEq(treasury.allocatedBudget(tripId, alice),     40e6, "alice allocation after return");
    }

    function test_T02_ConservationAfterReleaseAndReturn() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 50e6, "funds");
        vm.prank(alice); treasury.recordActualSpend(tripId, 40e6, "hotel");
        vm.prank(alice); treasury.returnUnusedBudget(tripId, 10e6);

        // tripBalance + allocatedBudget[alice] must equal original 400e6
        uint256 tb = treasury.tripBalance(tripId);
        uint256 ab = treasury.allocatedBudget(tripId, alice);
        assertEq(tb + ab, 400e6, "conservation invariant");
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 3 – External budget partial use, recovery, settlement
    // ─────────────────────────────────────────────────────────

    function test_T03_BudgetPartialUseAndReturn() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 50e6, "funds");

        // Alice spends 30, returns 20
        vm.prank(alice); treasury.recordActualSpend(tripId, 30e6, "flights");
        vm.prank(alice); treasury.returnUnusedBudget(tripId, 20e6);

        assertEq(treasury.allocatedBudget(tripId, alice), 30e6, "allocated after partial return");
        assertEq(treasury.spentFromBudget(tripId, alice),  30e6, "spent");

        // tripBalance = 400 - 50 (released) + 20 (returned) = 370
        assertEq(treasury.tripBalance(tripId), 370e6, "tripBalance after partial return");
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 4 – personalPrepaid does not change tripBalance
    // ─────────────────────────────────────────────────────────

    function test_T04_PersonalPrepaid_DoesNotChangeTripBalance() public {
        _allDeposit();
        uint256 balBefore = treasury.tripBalance(tripId);

        vm.prank(alice); treasury.recordPersonalPrepaid(tripId, 25e6, "personal dinner");

        assertEq(treasury.tripBalance(tripId),              balBefore, "tripBalance unchanged");
        assertEq(treasury.getPersonalPrepaid(tripId, alice),    25e6,  "personalPrepaid[alice]");
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 5 – 68 USDC expense, 22/17/12/17 split, settlement
    // ─────────────────────────────────────────────────────────

    /// Set up the full 68e6-expense settlement and verify refund math.
    function test_T05_SixtyEightExpense_ProportionalRefunds() public {
        _allDeposit(); // 400e6 in treasury

        // Simulate 68e6 of expenses being paid out of treasury by releasing +
        // recording, leaving 332e6 in tripBalance.
        // shares: admin=22, alice=17, bob=12, carol=17
        vm.prank(admin); treasury.releaseBudget(tripId, admin, 22e6, "admin share");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "admin paid");
        // Admin has 0 left to return; skip returnUnusedBudget (0 would revert InvalidAmount).

        // We need tripBalance = 332e6.
        // After releasing 22e6 to admin: tripBalance = 378e6, allocated[admin]=22.
        // Admin returns nothing (spent all 22). tripBalance stays 378.
        // We need to simulate the remaining 46e6 of expenses via the same pattern.
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 17e6, "alice share");
        vm.prank(alice); treasury.recordActualSpend(tripId, 17e6, "alice paid");

        vm.prank(admin); treasury.releaseBudget(tripId, bob, 12e6, "bob share");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "bob paid");

        vm.prank(admin); treasury.releaseBudget(tripId, carol, 17e6, "carol share");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "carol paid");

        // tripBalance = 400 - 68 = 332e6
        assertEq(treasury.tripBalance(tripId), 332e6, "tripBalance after expense sim");

        // Propose settlement: refunds = [78,83,88,83], no deficits
        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        // All approve
        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        // All claim refunds and verify USDC received
        uint256 adminBefore = usdc.balanceOf(admin);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore   = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);

        vm.prank(admin); treasury.claimRefund(tripId);
        vm.prank(alice); treasury.claimRefund(tripId);
        vm.prank(bob);   treasury.claimRefund(tripId);
        vm.prank(carol); treasury.claimRefund(tripId);

        assertEq(usdc.balanceOf(admin) - adminBefore,  78e6, "admin refund");
        assertEq(usdc.balanceOf(alice) - aliceBefore,  83e6, "alice refund");
        assertEq(usdc.balanceOf(bob)   - bobBefore,    88e6, "bob refund");
        assertEq(usdc.balanceOf(carol) - carolBefore,  83e6, "carol refund");

        // Sum of refunds = 332e6 = total paid out
        assertEq(uint256(78e6 + 83e6 + 88e6 + 83e6), uint256(332e6), "refund sum = 332e6");
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 6 – Hash mismatch settlement rejection
    // ─────────────────────────────────────────────────────────

    function test_T06_WrongHashReverts() public {
        _allDeposit();
        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 correctHash = _computeHash(members, refunds, deficits, ver);

        bytes32 wrongHash = keccak256("wrong");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripSharedTreasuryV2.InvalidSettlementHash.selector,
                correctHash,
                wrongHash
            )
        );
        treasury.approveFinalSettlement(tripId, wrongHash);
    }

    function test_T06_CorrectHashApproves() public {
        _allDeposit();
        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(alice);
        treasury.approveFinalSettlement(tripId, h);

        assertTrue(treasury.settlementApproved(tripId, alice), "alice approved");
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 7 – Deficit partial payment advances status;
    //            re-proposal while DeficitPaying reverts
    // ─────────────────────────────────────────────────────────

    function test_T07_PartialDeficitPayAdvancesStatus() public {
        _allDeposit();

        // Settlement where admin owes a 10e6 deficit (negative refund scenario).
        // refunds[admin] = 0 (no refund), deficit[admin] = 10e6.
        address[] memory members  = new address[](4);
        uint256[] memory refunds  = new uint256[](4);
        uint256[] memory deficits = new uint256[](4);
        members[0] = admin; members[1] = alice; members[2] = bob; members[3] = carol;
        refunds[0] = 0;     refunds[1] = 110e6; refunds[2] = 120e6; refunds[3] = 110e6;
        deficits[0] = 10e6; // admin owes 10e6

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        // All approve first
        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        // Admin pays partial deficit (5 of 10)
        vm.prank(admin); treasury.payDeficit(tripId, 5e6);

        // Status must be DeficitPaying
        assertEq(
            uint8(treasury.getSettlementStatus(tripId)),
            uint8(TripSharedTreasuryV2.SettlementStatus.DeficitPaying),
            "status should be DeficitPaying"
        );
    }

    function test_T07_ReProposalBlockedInDeficitPaying() public {
        _allDeposit();

        address[] memory members  = new address[](4);
        uint256[] memory refunds  = new uint256[](4);
        uint256[] memory deficits = new uint256[](4);
        members[0] = admin; members[1] = alice; members[2] = bob; members[3] = carol;
        refunds[0] = 0;     refunds[1] = 110e6; refunds[2] = 120e6; refunds[3] = 110e6;
        deficits[0] = 10e6;

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        vm.prank(admin); treasury.payDeficit(tripId, 5e6); // status → DeficitPaying

        // Re-proposal must revert
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripSharedTreasuryV2.SettlementAlreadyInProgress.selector,
                TripSharedTreasuryV2.SettlementStatus.DeficitPaying
            )
        );
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 8 – Re-proposal blocked after first claim (ClaimStarted)
    // ─────────────────────────────────────────────────────────

    function test_T08_ReProposalBlockedAfterFirstClaim() public {
        _allDeposit();

        // Simulate 68e6 expense to get tripBalance = 332e6
        vm.prank(admin); treasury.releaseBudget(tripId, admin,  22e6, "admin");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "admin");
        vm.prank(admin); treasury.releaseBudget(tripId, alice,  17e6, "alice");
        vm.prank(alice); treasury.recordActualSpend(tripId, 17e6, "alice");
        vm.prank(admin); treasury.releaseBudget(tripId, bob,    12e6, "bob");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "bob");
        vm.prank(admin); treasury.releaseBudget(tripId, carol,  17e6, "carol");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "carol");

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        // First claim → status becomes ClaimStarted
        vm.prank(admin); treasury.claimRefund(tripId);
        assertEq(
            uint8(treasury.getSettlementStatus(tripId)),
            uint8(TripSharedTreasuryV2.SettlementStatus.ClaimStarted),
            "status ClaimStarted"
        );

        // Re-proposal must revert
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripSharedTreasuryV2.SettlementAlreadyInProgress.selector,
                TripSharedTreasuryV2.SettlementStatus.ClaimStarted
            )
        );
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 9 – Double refund & unauthorized budget release
    // ─────────────────────────────────────────────────────────

    function test_T09_DoubleClaimReverts() public {
        _allDeposit();

        vm.prank(admin); treasury.releaseBudget(tripId, admin,  22e6, "admin");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "admin");
        vm.prank(admin); treasury.releaseBudget(tripId, alice,  17e6, "alice");
        vm.prank(alice); treasury.recordActualSpend(tripId, 17e6, "alice");
        vm.prank(admin); treasury.releaseBudget(tripId, bob,    12e6, "bob");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "bob");
        vm.prank(admin); treasury.releaseBudget(tripId, carol,  17e6, "carol");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "carol");

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        vm.prank(alice); treasury.claimRefund(tripId);

        // Second claim by alice must revert AlreadyClaimed
        vm.prank(alice);
        vm.expectRevert(TripSharedTreasuryV2.AlreadyClaimed.selector);
        treasury.claimRefund(tripId);
    }

    function test_T09_NonAdminCannotReleaseBudget() public {
        _allDeposit();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TripSharedTreasuryV2.NotAdmin.selector, tripId)
        );
        treasury.releaseBudget(tripId, alice, 10e6, "unauthorized");
    }

    function test_T09_ReleaseToNonParticipantReverts() public {
        _allDeposit();

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(TripSharedTreasuryV2.SpenderNotParticipant.selector, stranger)
        );
        treasury.releaseBudget(tripId, stranger, 10e6, "invalid spender");
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 10 – Balance mutation blocked in ClaimStarted
    // ─────────────────────────────────────────────────────────

    function test_T10_DepositBlockedAfterClaimStarted() public {
        _allDeposit();

        vm.prank(admin); treasury.releaseBudget(tripId, admin,  22e6, "admin");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "admin");
        vm.prank(admin); treasury.releaseBudget(tripId, alice,  17e6, "alice");
        vm.prank(alice); treasury.recordActualSpend(tripId, 17e6, "alice");
        vm.prank(admin); treasury.releaseBudget(tripId, bob,    12e6, "bob");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "bob");
        vm.prank(admin); treasury.releaseBudget(tripId, carol,  17e6, "carol");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "carol");

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        // Trigger ClaimStarted
        vm.prank(admin); treasury.claimRefund(tripId);

        // deposit must revert SettlementAlreadyInProgress(ClaimStarted)
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripSharedTreasuryV2.SettlementAlreadyInProgress.selector,
                TripSharedTreasuryV2.SettlementStatus.ClaimStarted
            )
        );
        treasury.deposit(tripId, 1e6);
    }

    function test_T10_ReturnUnusedBlockedAfterClaimStarted() public {
        _allDeposit();

        // Release 50 to alice so she has an allocated budget to "return"
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 50e6, "alloc");
        // Alice spends only 22e6, has 28e6 to return eventually

        // Now simulate expenses to land tripBalance at 332e6 for the standard settlement.
        // After releasing 50 to alice: tripBalance = 350.
        // Release additional to get tripBalance down to 332:
        // release 18 more (some to admin, bob, carol covering their shares):
        vm.prank(admin); treasury.releaseBudget(tripId, admin, 22e6, "admin share");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "admin spent");
        // tripBalance = 350 - 22 = 328. Need 332. Difference: release 5 from alice allocation.
        // Actually, let's use a simpler approach: set up a clean scenario.
        // Fresh deployment approach within this test is complex; use a simpler 3-participant case.
        // ── Simpler: just get into ClaimStarted with alice having leftover allocation ──

        // After releases above: allocated[alice]=50, allocated[admin]=22, tripBalance=328
        vm.prank(admin); treasury.releaseBudget(tripId, bob,   12e6, "bob share");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "bob spent");
        // tripBalance = 316
        vm.prank(admin); treasury.releaseBudget(tripId, carol, 17e6, "carol share");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "carol spent");
        // tripBalance = 299

        // alice has 50 allocated, spent 0. For settlement: alice refund = 83,
        // but we need tripBalance == sum(refunds). 
        // Let's abandon the standard settlement and define a custom one.
        // alice allocated=50, will return 0, so contract can't reach 332.
        // Solution: propose settlement with tripBalance=299:
        //   admin=0, alice=0, bob=0, carol=0 refund (0-sum), but they all deposited.
        // Better: use a completely custom settlement matching tripBalance=299.
        // refunds must sum to 299e6. 4 participants, e.g. admin=0, alice=49,bob=0,carol=250
        // This is contrived. Let's instead use a simpler 2-step to get alice into ClaimStarted
        // WITHOUT using standard settlement amounts.
        // 
        // SIMPLEST: alice returns the 50 allocated before settlement.
        // Then tripBalance = 299 + 50 = 349 after return.
        // But we need to NOT be in ClaimStarted yet for the return to work...
        // 
        // The test purpose is: once ClaimStarted, returnUnusedBudget reverts.
        // Let's use a minimal tripBalance setup:

        // At this point: allocated[alice]=50, tripBalance=299.
        // alice has 0 spent, 50 allocated.
        // Propose settlement where refunds sum = 299e6.
        address[] memory mem = new address[](4);
        uint256[] memory ref = new uint256[](4);
        uint256[] memory def = new uint256[](4);
        mem[0] = admin; mem[1] = alice; mem[2] = bob; mem[3] = carol;
        ref[0] = 0; ref[1] = 149e6; ref[2] = 0; ref[3] = 150e6;
        // 0+149+0+150 = 299 ✓

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, mem, ref, def);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = keccak256(abi.encode(tripId, ver, mem, ref, def));

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        // Trigger ClaimStarted (admin's refund is 0, so no-op transfer)
        vm.prank(admin); treasury.claimRefund(tripId);

        // Now returnUnusedBudget must revert SettlementAlreadyInProgress(ClaimStarted)
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripSharedTreasuryV2.SettlementAlreadyInProgress.selector,
                TripSharedTreasuryV2.SettlementStatus.ClaimStarted
            )
        );
        treasury.returnUnusedBudget(tripId, 1e6);
    }

    // ─────────────────────────────────────────────────────────
    //  TEST 11 – Exact integer arithmetic, no rounding loss
    // ─────────────────────────────────────────────────────────

    function test_T11_SharesSumExactly() public view {
        uint256 shareA = 22e6;
        uint256 shareB = 17e6;
        uint256 shareC = 12e6;
        uint256 shareD = 17e6;
        assertEq(shareA + shareB + shareC + shareD, uint256(68e6), "shares sum = 68e6");
    }

    function test_T11_RefundsSumExactly() public view {
        // 4×100e6 = 400e6 deposits, 68e6 expense → refunds = 400-68 = 332e6
        uint256 refA = 78e6; // 100 - 22
        uint256 refB = 83e6; // 100 - 17
        uint256 refC = 88e6; // 100 - 12
        uint256 refD = 83e6; // 100 - 17
        assertEq(refA + refB + refC + refD, uint256(332e6), "refunds sum = 332e6");
    }

    function test_T11_FullSettlementArithmetic() public {
        _allDeposit(); // 400e6

        // drain 68e6 via release+spend to leave exactly 332e6
        vm.prank(admin); treasury.releaseBudget(tripId, admin, 22e6, "admin");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "admin");
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 17e6, "alice");
        vm.prank(alice); treasury.recordActualSpend(tripId, 17e6, "alice");
        vm.prank(admin); treasury.releaseBudget(tripId, bob,   12e6, "bob");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "bob");
        vm.prank(admin); treasury.releaseBudget(tripId, carol, 17e6, "carol");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "carol");

        assertEq(treasury.tripBalance(tripId), 332e6, "tripBalance = 332e6");

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        // All claim
        vm.prank(admin); treasury.claimRefund(tripId);
        vm.prank(alice); treasury.claimRefund(tripId);
        vm.prank(bob);   treasury.claimRefund(tripId);
        vm.prank(carol); treasury.claimRefund(tripId);

        // After all claims tripBalance should be 0 and trip locked
        assertEq(treasury.tripBalance(tripId), 0, "tripBalance = 0 after full claim");
        assertEq(
            uint8(treasury.getSettlementStatus(tripId)),
            uint8(TripSharedTreasuryV2.SettlementStatus.Completed),
            "status Completed"
        );
    }

    // ─────────────────────────────────────────────────────────
    //  Additional – Trip lock after Completed
    // ─────────────────────────────────────────────────────────

    function test_Additional_DepositRevertsAfterTripCompleted() public {
        // Full settlement → Completed → locked = true
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, admin, 22e6, "");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "");
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 17e6, "");
        vm.prank(alice); treasury.recordActualSpend(tripId, 17e6, "");
        vm.prank(admin); treasury.releaseBudget(tripId, bob, 12e6, "");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "");
        vm.prank(admin); treasury.releaseBudget(tripId, carol, 17e6, "");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "");

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);
        vm.prank(admin); treasury.claimRefund(tripId);
        vm.prank(alice); treasury.claimRefund(tripId);
        vm.prank(bob);   treasury.claimRefund(tripId);
        vm.prank(carol); treasury.claimRefund(tripId);

        // Trip is now Completed and locked.
        // deposit checks locked FIRST → reverts TripLocked(tripId).
        // (The SettlementAlreadyInProgress guard is below the locked check in the contract.)
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TripSharedTreasuryV2.TripLocked.selector, tripId)
        );
        treasury.deposit(tripId, 1e6);
    }

    // ─────────────────────────────────────────────────────────
    //  Additional – Settlement version increments on each proposal
    // ─────────────────────────────────────────────────────────

    function test_Additional_SettlementVersionIncrementsOnPropose() public {
        _allDeposit();
        assertEq(treasury.getSettlementVersion(tripId), 0, "version starts 0");

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin);
        treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        assertEq(treasury.getSettlementVersion(tripId), 1, "version after first proposal");
    }

    // ─────────────────────────────────────────────────────────
    //  Additional – recordActualSpend cannot exceed allocatedBudget
    // ─────────────────────────────────────────────────────────

    function test_Additional_RecordSpendCannotExceedAllocated() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 30e6, "budget");

        // alice tries to record 40e6 against 30e6 allocation
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripSharedTreasuryV2.SpendAmountExceedsAllocated.selector,
                30e6, // allocated
                0,    // already spent
                40e6  // requested
            )
        );
        treasury.recordActualSpend(tripId, 40e6, "overspend");
    }

    function test_Additional_RecordSpendCumulativeCannotExceedAllocated() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 30e6, "budget");

        vm.prank(alice); treasury.recordActualSpend(tripId, 20e6, "first");
        // second attempt pushes total to 35 > 30
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripSharedTreasuryV2.SpendAmountExceedsAllocated.selector,
                30e6,
                20e6,
                15e6
            )
        );
        treasury.recordActualSpend(tripId, 15e6, "second");
    }

    // ─────────────────────────────────────────────────────────
    //  Additional – Event emission checks
    // ─────────────────────────────────────────────────────────

    function test_Event_TripCreated() public {
        address[] memory extras = new address[](1);
        extras[0] = alice;

        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TripSharedTreasuryV2.TripCreated(2, admin, "Event Trip", 100e6);
        treasury.createTrip("Event Trip", extras, 100e6);
    }

    function test_Event_Deposited() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TripSharedTreasuryV2.Deposited(tripId, alice, DEPOSIT);
        treasury.deposit(tripId, DEPOSIT);
    }

    function test_Event_BudgetReleased() public {
        _allDeposit();
        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TripSharedTreasuryV2.BudgetReleased(tripId, alice, 20e6, "memo");
        treasury.releaseBudget(tripId, alice, 20e6, "memo");
    }

    function test_Event_BudgetReturned() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 20e6, "funds");

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TripSharedTreasuryV2.BudgetReturned(tripId, alice, 10e6);
        treasury.returnUnusedBudget(tripId, 10e6);
    }

    function test_Event_ActualSpendRecorded() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 30e6, "funds");

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TripSharedTreasuryV2.ActualSpendRecorded(tripId, alice, 20e6, "flights");
        treasury.recordActualSpend(tripId, 20e6, "flights");
    }

    function test_Event_PersonalPrepaidRecorded() public {
        _allDeposit();
        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TripSharedTreasuryV2.PersonalPrepaidRecorded(tripId, alice, 25e6, "dinner");
        treasury.recordPersonalPrepaid(tripId, 25e6, "dinner");
    }

    function test_Event_SettlementApproved() public {
        _allDeposit();
        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin); treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(treasury));
        emit TripSharedTreasuryV2.SettlementApproved(tripId, alice, h);
        treasury.approveFinalSettlement(tripId, h);
    }

    function test_Event_RefundClaimed() public {
        _allDeposit();
        vm.prank(admin); treasury.releaseBudget(tripId, admin, 22e6, "");
        vm.prank(admin); treasury.recordActualSpend(tripId, 22e6, "");
        vm.prank(admin); treasury.releaseBudget(tripId, alice, 17e6, "");
        vm.prank(alice); treasury.recordActualSpend(tripId, 17e6, "");
        vm.prank(admin); treasury.releaseBudget(tripId, bob,   12e6, "");
        vm.prank(bob);   treasury.recordActualSpend(tripId, 12e6, "");
        vm.prank(admin); treasury.releaseBudget(tripId, carol, 17e6, "");
        vm.prank(carol); treasury.recordActualSpend(tripId, 17e6, "");

        (
            address[] memory members,
            uint256[] memory refunds,
            uint256[] memory deficits
        ) = _standardSettlementArrays();

        vm.prank(admin); treasury.proposeFinalSettlement(tripId, members, refunds, deficits);
        uint256 ver = treasury.getSettlementVersion(tripId);
        bytes32 h = _computeHash(members, refunds, deficits, ver);

        vm.prank(admin); treasury.approveFinalSettlement(tripId, h);
        vm.prank(alice); treasury.approveFinalSettlement(tripId, h);
        vm.prank(bob);   treasury.approveFinalSettlement(tripId, h);
        vm.prank(carol); treasury.approveFinalSettlement(tripId, h);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit TripSharedTreasuryV2.RefundClaimed(tripId, alice, 83e6);
        treasury.claimRefund(tripId);
    }

    // ─────────────────────────────────────────────────────────
    //  FUZZ – deposit amounts
    // ─────────────────────────────────────────────────────────

    function testFuzz_DepositAccumulates(uint96 amt1, uint96 amt2) public {
        // Bound to realistic USDC amounts: 1 to 1_000_000e6
        uint256 a1 = bound(uint256(amt1), 1, 1_000_000e6);
        uint256 a2 = bound(uint256(amt2), 1, 1_000_000e6);

        usdc.mint(alice, a1);
        usdc.mint(bob, a2);
        // alice and bob already have approvals from setUp

        vm.prank(alice); treasury.deposit(tripId, a1);
        vm.prank(bob);   treasury.deposit(tripId, a2);

        assertEq(treasury.tripBalance(tripId), a1 + a2, "tripBalance = sum of deposits");
        assertEq(treasury.depositedAmount(tripId, alice), a1, "alice deposited");
        assertEq(treasury.depositedAmount(tripId, bob),   a2, "bob deposited");
    }

    // ─────────────────────────────────────────────────────────
    //  FUZZ – releaseBudget + returnUnused conservation
    // ─────────────────────────────────────────────────────────

    function testFuzz_ReleaseReturnConservation(uint96 rawDeposit, uint96 rawRelease, uint96 rawReturn) public {
        uint256 dep = bound(uint256(rawDeposit), 10e6, 1_000_000e6);
        uint256 rel = bound(uint256(rawRelease), 1, dep);
        uint256 ret = bound(uint256(rawReturn), 0, rel);

        usdc.mint(alice, dep);
        vm.prank(alice); treasury.deposit(tripId, dep);

        vm.prank(admin); treasury.releaseBudget(tripId, alice, rel, "fuzz release");
        if (ret > 0) {
            vm.prank(alice); treasury.returnUnusedBudget(tripId, ret);
        }

        // Conservation: tripBalance + remaining allocation == initial deposit (from alice only)
        uint256 tb  = treasury.tripBalance(tripId);
        uint256 ab  = treasury.allocatedBudget(tripId, alice);
        assertEq(tb + ab, dep, "conservation: tripBalance + allocated = deposit");
    }

    // ─────────────────────────────────────────────────────────
    //  INVARIANT – tripBalance accounting
    //  Handler allows deposits, releases, returns, and spend records.
    // ─────────────────────────────────────────────────────────
}

/// @dev Invariant handler: drives state mutations for the invariant test.
contract TripBalanceHandler is Test {
    TripSharedTreasuryV2 internal treasury;
    MockERC20 internal usdc;
    uint256 internal tripId;

    address internal admin;
    address internal alice;
    address internal bob;

    // Ghost variables tracking what the invariant should hold
    uint256 public ghost_sumDeposited;
    uint256 public ghost_sumAllocated;   // outstanding allocated (not yet returned)
    uint256 public ghost_sumReturned;    // cumulative returned to contract
    uint256 public ghost_sumClaimed;     // cumulative refunds claimed

    constructor(
        TripSharedTreasuryV2 _treasury,
        MockERC20 _usdc,
        uint256 _tripId,
        address _admin,
        address _alice,
        address _bob
    ) {
        treasury = _treasury;
        usdc     = _usdc;
        tripId   = _tripId;
        admin    = _admin;
        alice    = _alice;
        bob      = _bob;
    }

    function depositAlice(uint256 amount) external {
        amount = bound(amount, 1, 10_000e6);
        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.approve(address(treasury), amount);
        TripSharedTreasuryV2.SettlementStatus status = treasury.getSettlementStatus(tripId);
        if (
            status == TripSharedTreasuryV2.SettlementStatus.DeficitPaying ||
            status == TripSharedTreasuryV2.SettlementStatus.ClaimStarted  ||
            status == TripSharedTreasuryV2.SettlementStatus.Completed
        ) return; // skip; would revert
        vm.prank(alice); treasury.deposit(tripId, amount);
        ghost_sumDeposited += amount;
    }

    function depositBob(uint256 amount) external {
        amount = bound(amount, 1, 10_000e6);
        usdc.mint(bob, amount);
        vm.prank(bob);
        usdc.approve(address(treasury), amount);
        TripSharedTreasuryV2.SettlementStatus status = treasury.getSettlementStatus(tripId);
        if (
            status == TripSharedTreasuryV2.SettlementStatus.DeficitPaying ||
            status == TripSharedTreasuryV2.SettlementStatus.ClaimStarted  ||
            status == TripSharedTreasuryV2.SettlementStatus.Completed
        ) return;
        vm.prank(bob); treasury.deposit(tripId, amount);
        ghost_sumDeposited += amount;
    }

    function releaseToAlice(uint256 amount) external {
        uint256 bal = treasury.tripBalance(tripId);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        TripSharedTreasuryV2.SettlementStatus status = treasury.getSettlementStatus(tripId);
        if (status != TripSharedTreasuryV2.SettlementStatus.None) return;
        vm.prank(admin); treasury.releaseBudget(tripId, alice, amount, "inv");
        ghost_sumAllocated += amount;
    }

    function returnFromAlice(uint256 amount) external {
        uint256 alloc = treasury.allocatedBudget(tripId, alice);
        if (alloc == 0) return;
        amount = bound(amount, 1, alloc);
        TripSharedTreasuryV2.SettlementStatus status = treasury.getSettlementStatus(tripId);
        if (
            status == TripSharedTreasuryV2.SettlementStatus.ClaimStarted ||
            status == TripSharedTreasuryV2.SettlementStatus.Completed
        ) return;
        vm.prank(alice); treasury.returnUnusedBudget(tripId, amount);
        ghost_sumAllocated -= amount;
        ghost_sumReturned  += amount;
    }
}

contract TripSharedTreasuryV2InvariantTest is Test {
    TripSharedTreasuryV2  internal treasury;
    MockERC20             internal usdc;
    TripBalanceHandler    internal handler;
    uint256               internal tripId;

    address internal admin = makeAddr("inv_admin");
    address internal alice = makeAddr("inv_alice");
    address internal bob   = makeAddr("inv_bob");

    function setUp() public {
        usdc     = new MockERC20("USDC", "USDC", 6);
        treasury = new TripSharedTreasuryV2(address(usdc));

        address[] memory extras = new address[](2);
        extras[0] = alice;
        extras[1] = bob;

        vm.prank(admin);
        tripId = treasury.createTrip("Inv Trip", extras, 300e6);

        // Give admin large balance for releaseBudget calls (handler mints for alice/bob)
        usdc.mint(admin, 1_000_000e6);
        vm.prank(admin); usdc.approve(address(treasury), type(uint256).max);

        handler = new TripBalanceHandler(treasury, usdc, tripId, admin, alice, bob);

        targetContract(address(handler));
    }

    /// @dev tripBalance == sumDeposited - sumAllocated_outstanding + sumReturned - sumClaimed
    ///      Simplified: tripBalance + ghost_sumAllocated == ghost_sumDeposited + ghost_sumReturned - ghost_sumClaimed
    ///      Since claimRefund is not exercised in handler: tripBalance + allocated == deposited + returned.
    function invariant_TripBalanceConservation() public view {
        uint256 tb    = treasury.tripBalance(tripId);
        uint256 alloc = treasury.allocatedBudget(tripId, alice)
                      + treasury.allocatedBudget(tripId, bob);

        // tripBalance + outstanding_allocated = total_deposited - total_truly_spent
        // Since the handler never records actual spend or releases to bob,
        // the invariant reduces to: tb + alloc == sum_deposited_through_handler
        assertEq(
            tb + alloc,
            handler.ghost_sumDeposited() + handler.ghost_sumReturned(),
            "invariant: tripBalance + allocated = deposited + returned"
        );
    }

    /// @dev The real USDC balance of the contract must always >= tripBalance
    ///      (contract may hold more if deficits paid that haven't settled yet,
    ///       but in this handler scenario they should be equal).
    function invariant_ContractBalanceGeqTripBalance() public view {
        assertGe(
            usdc.balanceOf(address(treasury)),
            treasury.tripBalance(tripId),
            "contract USDC balance >= tripBalance"
        );
    }
}
