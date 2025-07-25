import { asyncHandler } from '../utils/asyncHandler.js'
import { ApiError } from '../utils/ApiError.js'
import { User } from '../models/user.model.js'
import { uploadOnCloudinary } from '../utils/cloudinary.js'
import { ApiResponse } from '../utils/ApiResponse.js'
import jwt from "jsonwebtoken"
import mongoose from 'mongoose'

const generateAccessAndRefreshTokens = async (userId) => {
    try {
        const user = await User.findById(userId);
        const AccessToken = user.generateAccessToken();
        const RefreshToken = user.generateRefreshToken();

        user.refreshToken = RefreshToken;
        await user.save({ validateBeforeSave: false })

        return { AccessToken, RefreshToken }
    } catch (error) {
        throw new ApiError(500, "Something went wrong - token not generated")
    }
}

const registerUser = asyncHandler(async (req, res) => {
    /* steps for this Register controllers
        1. Get user details from the user.
        2. Validation - Not Empty.
        3. Check if user already Exits: Username and email.
        4. check for images, check for  avatar [compulsory].
        5. upload the images to cloudinary.
        6. create user object - Nosql, Create Entry in DB.
        7. Remove Password and Refresh token field from response.
        8. Check for User Creation.
        9. return the response.
    */

    const { fullname, email, username, password } = req.body
    console.log("fullname: ", fullname, "email: ", email)

    // Validation - check if all required fields are provided
    if (
        [fullname, email, username, password].some((field) =>
            field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required.")
    }

    // Check if user already exists
    const existedUser = await User.findOne({
        $or: [{ username }, { email }]
    })

    if (existedUser) {
        throw new ApiError(409, "User with email or username already exists.")
    }

    // Handle file uploads - add safety checks
    const avatarLocalPath = req.files?.avatar?.[0]?.path;
    const coverImageLocalPath = req.files?.coverImage?.[0]?.path;

    if (!avatarLocalPath) {
        throw new ApiError(400, "Avatar file is required.")
    }

    // Upload avatar to cloudinary
    const avatar = await uploadOnCloudinary(avatarLocalPath);
    if (!avatar?.url) {
        throw new ApiError(400, "Failed to upload avatar to cloudinary.");
    }

    // Upload cover image if provided
    let coverImageUrl = "";
    if (coverImageLocalPath) {
        const coverImage = await uploadOnCloudinary(coverImageLocalPath);
        if (coverImage?.url) {
            coverImageUrl = coverImage.url;
        }
    }

    // Create user
    const user = await User.create({
        fullname,
        avatar: avatar.url,
        coverImage: coverImageUrl,
        email,
        password,
        username: username.toLowerCase(),
    });

    // Fetch created user without password and refresh token
    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    );

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong during registration")
    }

    return res.status(201).json(
        new ApiResponse(201, createdUser, "User registered successfully")
    )
})

const loginUser = asyncHandler(async (req, res) => {
    /*  
        req body -> data
        username or email base login
        find the user
        password check
        access and refresh token
        send in secure cookies
    */

    const { email, username, password } = req.body;
    console.log(req.body)

    // Check if username or email is provided
    if (!(username && email)) {
        throw new ApiError(400, "Username or email is required")
    }

    // Check if password is provided
    if (!password) {
        throw new ApiError(400, "Password is required")
    }

    // Find user by username or email
    const user = await User.findOne({
        $or: [{ email }, { username }]
    })

    if (!user) {
        throw new ApiError(404, "User does not exist")
    }

    // Check password
    const isPasswordValid = await user.isPasswordCorrect(password);

    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid user credentials")
    }

    // Generate tokens
    const { AccessToken, RefreshToken } = await generateAccessAndRefreshTokens(user._id)

    // Get user without password and refresh token
    const loggedInUser = await User.findById(user._id).select("-password -refreshToken")

    // Cookie options
    const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Only secure in production
        sameSite: 'strict'
    }

    return res
        .status(200)
        .cookie("accessToken", AccessToken, options)
        .cookie("refreshToken", RefreshToken, options)
        .json(
            new ApiResponse(
                200,
                {
                    user: loggedInUser,
                    AccessToken,
                    RefreshToken
                },
                "User logged in successfully"
            )
        )
})

const logoutuser = asyncHandler(async (req, res) => {
    // Clear refresh token from database
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: {
                refreshToken: 1 // Use $unset instead of $set with undefined
            }
        },
        {
            new: true
        }
    )

    const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    }

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "User logged out successfully"))
})

const refreshAccessToken = asyncHandler(async (req, res) => {
    const incomingrefreshtoken = req.cookies.refreshToken || req.body.refreshToken;
    if (!incomingrefreshtoken) {
        throw new ApiError(401, "unauthorised request");
    }

    try {
        const decodedToken = jwt.verify(incomingrefreshtoken, process.env.REFRESH_TOKEN_SECRET)


        const user = await User.findById(decodedToken?._id);
        if (!user) {
            throw new ApiError(401, "Invalid refresh Token")
        }

        if (incomingrefreshtoken !== user?.refreshToken) {
            throw new ApiError(401, "Refresh token is expired or used")
        }

        const options = {
            httpOnly: true,
            secure: true
        }

        const { accessToken, newrefreshToken } = await generateAccessAndRefreshTokens(user._id);

        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", newrefreshToken, options)
            .json(
                new ApiResponse(
                    200,
                    {
                        accessToken, newrefreshToken
                    },
                    "Acess token refreshed"
                )
            )
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid Refresh token")
    }
})

const changeCurrentPassword = asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const user = await User.findById(req.user?._id);
    const isPasswordCorrect = await user.isPasswordCorrect(oldPassword);

    if (!isPasswordCorrect) {
        throw new ApiError(400, "Invalid Old password")
    }

    user.password = newPassword;
    await user.save({
        validateBeforeSave: false
    });

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "password changed sucessfully")
        )
})

const getCurrentUser = asyncHandler(async (req, res) => {
    return res
        .status(200)
        .json(new ApiResponse(200, req.user, "Current user fetched"))
})

const updateAccountDetails = asyncHandler(async (req, res) => {
    const { fullname, email } = req.body

    if (!(fullname || email)) {
        throw new ApiError(400, "All field are required")
    }

    const user = await User.findByIdAndUpdate(req.user?._id,
        {
            $set: {
                fullname,
                email: email,
            }
        },
        { new: true }
    ).select("-password")

    return res
        .status(200)
        .json(new ApiResponse(200, user, "account Details updated successfully"))
})

const updateUserAvatar = asyncHandler(async (req, res) => {
    const avatarLocalPath = req.file?.path;
    if (!avatarLocalPath) {
        throw new ApiError(400, "Avatar file missing");
    }
    const avatar = await uploadOnCloudinary(avatarLocalPath)

    if (!avatar.url) {
        throw new ApiError(400, "Error while uploading on avatar")
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                avatar: avatar.url
            }
        },
        { new: true }
    ).select("-password")

    res
        .status(200)
        .json(
            new ApiResponse(200, user, "Avatar Updated successfully")
        )
})

const updateUserCoverImage = asyncHandler(async (req, res) => {
    const coverImageLocalPath = req.file?.path;
    if (!coverImageLocalPath) {
        throw new ApiError(400, "coverImage file missing");
    }
    const coverImage = await uploadOnCloudinary(coverImageLocalPath)

    if (!coverImage.url) {
        throw new ApiError(400, "Error while uploading on coverImage")
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                coverImage: coverImage.url
            }
        },
        { new: true }
    ).select("-password")

    res
        .status(200)
        .json(
            new ApiResponse(200, user, "coverImage Updated successfully")
        )
})

const getUserChannelProfile = asyncHandler(async (req, res) => {
    const { username } = req.params
    if (!username?.trim()) {
        throw new ApiError(400, "Username is missing.")
    }

    const channel = await User.aggregate([
        {
            $match: {
                username: username?.toLowerCase()
            },
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel", // this get us the all about kon kon iss channel ko subscribe krke rakha hai Means 1 M subscriber
                as: "subscribers"
            }
        },

        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "subscriber", // this gives us the ki iss user ne kis _id ko follow krta h hitesh -> kis kis ko follow // 200 ko follow krta h
                as: "subscribedTo"
            }
        },

        {
            $addFields: {
                subscribersCount: {
                    $size: "$subscribers"
                },
                channelssubscribedToCount: {
                    $size: "$subscribedTo"
                },
                isSubscribed: {
                    $cond: {
                        if: {$in: [req.user?._id, "$subscribers.subscriber"] },
                        then: true,
                        else: false
                    }
                }
            }
        },

        {
            $project: {
                fullname: 1,
                username: 1,
                subscribersCount: 1,
                channelssubscribedToCount: 1,
                isSubscribed: 1,
                avatar: 1,
                coverImage: 1,
                email: 1
            }
        }
    ])

    if (!channel?.length){
        throw new ApiError(404, "channel does not exists")
    }
    return res
        .status(200)
        .json(
            new ApiResponse(200, channel[0], "User channel fetched successfully.")
        )

})

const getWatchHistory = asyncHandler(async (req, res) => {
    const user = await User.aggregate(
        [
            {
                $match: {
                    _id: new mongoose.Types.ObjectId(
                        req.user._id
                    )
                }
            },
            {
                $lookup: {
                    from: "videos",
                    localField: "watchHistory",
                    foreignField: "_id",
                    as: "watchHistory",
                    pipeline: [
                        {
                            $lookup: {
                                from: "users",
                                localField: "owner",
                                foreignField: "_id",
                                as: "owner",
                                pipeline: [
                                    {
                                        $project: {
                                            fullname: 1,
                                            username: 1,
                                            avatar: 1
                                        }
                                    }
                                ]
                            }
                        },
                        {
                            $addFields: {
                                owner: {
                                    $first: "$owner"
                                }
                            }
                        }
                    ]
                }
            }
        ]
    )

    return res
        .status(200)
        .json(new ApiResponse(
            200,
            user[0].watchHistory,
            "Watch history successfully."
        ))
})

export { registerUser, loginUser, logoutuser, refreshAccessToken, changeCurrentPassword, getCurrentUser, updateAccountDetails, updateUserAvatar, updateUserCoverImage, getUserChannelProfile, getWatchHistory }